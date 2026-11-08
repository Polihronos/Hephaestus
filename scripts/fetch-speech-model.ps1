$ErrorActionPreference='Stop'
$taskProjectRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'verified-download.ps1')
$taskModelRoot=Join-Path $taskProjectRoot 'speech\models\base.en'
foreach($taskModelFile in @('config.json','tokenizer.json','vocabulary.txt','model.bin')){
    $taskDestination=Join-Path $taskModelRoot $taskModelFile
    $taskUri='https://huggingface.co/Systran/faster-whisper-base.en/resolve/main/'+$taskModelFile
    if($taskModelFile -eq 'model.bin'){
        Get-VerifiedDownload -WorkspaceRoot $taskProjectRoot -Destination $taskDestination -Uri $taskUri -Sha256 '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef' | Out-Null
    }else{
        $taskMetadataName=$taskModelFile
        $taskValidateMetadata={param($Path) Test-SpeechModelMetadata -Path $Path -Name $taskMetadataName}.GetNewClosure()
        Get-VerifiedDownload -WorkspaceRoot $taskProjectRoot -Destination $taskDestination -Uri $taskUri -Validate $taskValidateMetadata | Out-Null
    }
}
Write-Output 'Local transcription model verified.'
