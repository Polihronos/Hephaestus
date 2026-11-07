$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path '.runtime-downloads' -Force | Out-Null
$package = Get-Content -LiteralPath 'node_modules\electron\package.json' -Raw | ConvertFrom-Json
$version = $package.version
$archiveName = "electron-v$version-win32-x64.zip"
if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) {
    $archive = Join-Path $projectRoot '.runtime-downloads\electron.zip'
    if (-not (Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri "https://github.com/electron/electron/releases/download/v$version/$archiveName" -OutFile $archive -UseBasicParsing -TimeoutSec 300
    }
    $checksums = Get-Content -LiteralPath 'node_modules\electron\checksums.json' -Raw | ConvertFrom-Json
    $expected = $checksums.$archiveName
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $expected -or $actual -ne $expected.ToLowerInvariant()) { throw 'Desktop runtime checksum does not match the official package' }
    Expand-Archive -LiteralPath $archive -DestinationPath 'node_modules\electron\dist' -Force
    Set-Content -LiteralPath 'node_modules\electron\path.txt' -Value 'electron.exe' -NoNewline
}
Write-Output 'Desktop runtime verified.'
