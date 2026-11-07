$ErrorActionPreference='Stop'
$taskModelRoot=Join-Path (Split-Path -Parent $PSScriptRoot) 'speech\models\base.en'
New-Item -ItemType Directory -Path $taskModelRoot -Force | Out-Null
foreach($taskModelFile in @('config.json','tokenizer.json','vocabulary.txt','model.bin')){
    $taskDestination=Join-Path $taskModelRoot $taskModelFile
    if(-not (Test-Path -LiteralPath $taskDestination)){
        $taskTemporary=$taskDestination+'.download'
        Invoke-WebRequest -Uri ('https://huggingface.co/Systran/faster-whisper-base.en/resolve/main/'+$taskModelFile) -OutFile $taskTemporary -UseBasicParsing -TimeoutSec 300
        Move-Item -LiteralPath $taskTemporary -Destination $taskDestination -Force
    }
}
$taskModelHash=(Get-FileHash -LiteralPath (Join-Path $taskModelRoot 'model.bin') -Algorithm SHA256).Hash.ToLowerInvariant()
if($taskModelHash -ne '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef'){throw 'Local speech model checksum mismatch'}
Write-Output 'Local transcription model verified.'
