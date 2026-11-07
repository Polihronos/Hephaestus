$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'ScreenCompanion'
$resolvedInstall = [IO.Path]::GetFullPath($installRoot)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ScreenCompanion'))
if($resolvedInstall -ne $allowedRoot){throw 'Unexpected installation target'}
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -Path (Join-Path $projectRoot 'node_modules\electron\dist\*') -Destination $installRoot -Recurse -Force
Move-Item -LiteralPath (Join-Path $installRoot 'electron.exe') -Destination (Join-Path $installRoot 'ScreenCompanion.exe') -Force
$appRoot=Join-Path $installRoot 'resources\app'
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appRoot 'node_modules') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\ws') -Destination (Join-Path $appRoot 'node_modules') -Recurse -Force
foreach($directory in @('src','ui','assets','scripts','speech')){Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $appRoot -Recurse -Force}
if(-not (Test-Path -LiteralPath (Join-Path $appRoot '.venv\Scripts\python.exe'))){Copy-Item -LiteralPath (Join-Path $projectRoot '.venv') -Destination $appRoot -Recurse -Force}
New-Item -ItemType Directory -Path (Join-Path $appRoot 'native\bin') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\bin\release') -Destination (Join-Path $appRoot 'native\bin') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $appRoot -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $appRoot -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $appRoot -Force
$codexPath=(Get-Command codex -ErrorAction Stop).Source
$runtimeJson=@{codexPath=$codexPath} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $appRoot 'runtime-config.json'),$runtimeJson,(New-Object Text.UTF8Encoding($false)))
Add-Type -AssemblyName System.Drawing
$spriteBitmap=[Drawing.Bitmap]::FromFile((Join-Path $appRoot 'assets\hephaestus-sprites\frames\idle-00.png'))
$bitmap=New-Object Drawing.Bitmap(160,160)
$taskGraphics=[Drawing.Graphics]::FromImage($bitmap)
$taskGraphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$taskGraphics.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::Half
$taskGraphics.DrawImage($spriteBitmap,16,0,128,160)
$taskGraphics.Dispose();$spriteBitmap.Dispose()
$icon=[Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconStream=[IO.File]::Create((Join-Path $installRoot 'ScreenCompanion.ico'));$icon.Save($iconStream);$iconStream.Dispose();$bitmap.Dispose()
$shortcutShell=New-Object -ComObject WScript.Shell
$shortcutDirectories=@([Environment]::GetFolderPath('DesktopDirectory'),(Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
foreach($shortcutDirectory in $shortcutDirectories){
    $shortcut=$shortcutShell.CreateShortcut((Join-Path $shortcutDirectory 'Hephaestus.lnk'))
    $shortcut.TargetPath=Join-Path $installRoot 'ScreenCompanion.exe'
    $shortcut.WorkingDirectory=$installRoot
    $shortcut.IconLocation=Join-Path $installRoot 'ScreenCompanion.ico'
    $shortcut.Description='Hephaestus: dashboard, screen-aware conversation, and desktop companion'
    $shortcut.Save()
    $taskOldShortcut=Join-Path $shortcutDirectory 'Screen Companion.lnk'
    if(Test-Path -LiteralPath $taskOldShortcut){$taskOldLink=$shortcutShell.CreateShortcut($taskOldShortcut);if($taskOldLink.TargetPath -eq (Join-Path $installRoot 'ScreenCompanion.exe')){Remove-Item -LiteralPath $taskOldShortcut}}
}
Write-Output ('Installed: '+(Join-Path $installRoot 'ScreenCompanion.exe'))
Write-Output 'Desktop and Start menu shortcuts created.'
