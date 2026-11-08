$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'verified-download.ps1')
$package = Get-Content -LiteralPath 'node_modules\electron\package.json' -Raw | ConvertFrom-Json
$version = $package.version
$archiveName = "electron-v$version-win32-x64.zip"
$checksums = Get-Content -LiteralPath 'node_modules\electron\checksums.json' -Raw | ConvertFrom-Json
$expected = $checksums.$archiveName
if (-not $expected) { throw 'The official package has no checksum for this desktop runtime' }
$archive = Get-VerifiedDownload -WorkspaceRoot $projectRoot -Destination (Join-Path $projectRoot '.runtime-downloads\electron.zip') -Uri "https://github.com/electron/electron/releases/download/v$version/$archiveName" -Sha256 $expected
Install-VerifiedRuntimeArchive -WorkspaceRoot $projectRoot -Archive $archive -Destination (Join-Path $projectRoot 'node_modules\electron\dist')
$taskPathFile = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $projectRoot -Path (Join-Path $projectRoot 'node_modules\electron\path.txt')
Set-Content -LiteralPath $taskPathFile -Value 'electron.exe' -NoNewline
Write-Output 'Desktop runtime verified.'
