$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Depth 8 -Compress)) }
try {
    $recognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'en-US' } | Select-Object -First 1
    if (-not $recognizerInfo) { throw 'No offline English Windows speech recognizer is installed.' }
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizerInfo)
    $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $choices = New-Object System.Speech.Recognition.Choices
    $choices.Add([string[]]@('go to the next tab','next tab','previous tab','go to the previous tab','open a new tab','click here','click there','scroll down','scroll up','go to the browser','stop','stop now','pause listening','mute microphone'))
    $builder = New-Object System.Speech.Recognition.GrammarBuilder($choices)
    $grammar = New-Object System.Speech.Recognition.Grammar($builder)
    $recognizer.LoadGrammar($grammar)
    $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(1)
    $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
    $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(650)
    Emit @{event='ready';model='Windows speech';engine='offline'}
} catch { Emit @{event='failed';error=$_.Exception.Message}; exit 1 }

while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    $audioStream = $null
    try {
        $request = $line | ConvertFrom-Json
        $timer = [Diagnostics.Stopwatch]::StartNew()
        if ($request.command -eq 'file') {
            $recognizer.SetInputToWaveFile([string]$request.params.path)
        } else {
            $bytes = [Convert]::FromBase64String([string]$request.params.audio)
            if ($bytes.Length -lt 9600 -or $bytes.Length -gt 2048000 -or $bytes.Length % 4 -ne 0) { throw 'Invalid microphone audio buffer' }
            $floats = New-Object single[] ($bytes.Length / 4)
            [Buffer]::BlockCopy($bytes,0,$floats,0,$bytes.Length)
            $pcm = New-Object byte[] ($floats.Length * 2)
            for ($i=0; $i -lt $floats.Length; $i++) {
                $sample = [int16]([Math]::Max(-32768,[Math]::Min(32767,[Math]::Round($floats[$i]*32767))))
                $encoded = [BitConverter]::GetBytes($sample)
                $pcm[$i*2] = $encoded[0]; $pcm[$i*2+1] = $encoded[1]
            }
            $audioStream = New-Object System.IO.MemoryStream(,$pcm)
            $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
            $recognizer.SetInputToAudioStream($audioStream,$format)
        }
        $parts = New-Object System.Collections.Generic.List[string]
        while ($true) {
            try { $result = $recognizer.Recognize() } catch { if($parts.Count -gt 0){break}; throw }
            if($null -eq $result){break}
            if ($result.Confidence -ge 0.2) { $parts.Add($result.Text) }
        }
        $timer.Stop()
        Emit @{id=$request.id;result=@{text=($parts -join ' ');elapsedMs=$timer.ElapsedMilliseconds;language='en'}}
    } catch { Emit @{id=$request.id;error=$_.Exception.Message} }
    finally { if($audioStream){$audioStream.Dispose()} }
}
$recognizer.Dispose()
