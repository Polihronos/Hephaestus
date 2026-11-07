$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw 'Codex CLI is required. Install it and sign in with ChatGPT.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Desktop runtime setup failed' }
& (Join-Path $PSScriptRoot 'fetch-runtime.ps1')
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) { uv venv --python 3.11 .venv; if ($LASTEXITCODE -ne 0) { throw 'Local speech environment setup failed' } }
uv pip install --python .venv\Scripts\python.exe -r speech\requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Local transcription dependencies failed to install' }
& (Join-Path $PSScriptRoot 'fetch-speech-model.ps1')
dotnet build native\ScreenBridge.csproj -c Release -o native\bin\release
if ($LASTEXITCODE -ne 0) { throw 'Windows bridge build failed' }
Write-Output 'Setup complete. Start with Start Screen Companion.vbs.'
