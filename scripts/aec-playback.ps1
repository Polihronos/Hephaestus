Add-Type -AssemblyName System.Speech
$taskSpeaker=New-Object System.Speech.Synthesis.SpeechSynthesizer
$taskSpeaker.Rate=0
$taskSpeaker.Speak('Hephaestus is checking speaker playback cancellation. This sentence is coming from the computer, and should not be treated as a request.')
$taskSpeaker.Dispose()
