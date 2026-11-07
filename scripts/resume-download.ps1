param([Parameter(Mandatory=$true)][string]$Uri,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][long]$ExpectedSize)
$ErrorActionPreference = 'Stop'
$path = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Destination))
for ($attempt=0; $attempt -lt 12; $attempt++) {
    $offset = if(Test-Path -LiteralPath $path){(Get-Item -LiteralPath $path).Length}else{0}
    if($offset -eq $ExpectedSize){Write-Output "Download complete: $Destination ($offset bytes)";exit 0}
    if($offset -gt $ExpectedSize){throw 'The partial download exceeds the expected file size'}
    $response=$null;$inputStream=$null;$outputStream=$null
    try {
        $request = [Net.HttpWebRequest]::Create($Uri)
        $request.Timeout=30000;$request.ReadWriteTimeout=20000
        $request.UserAgent='ScreenCompanion/1.0'
        if($offset -gt 0){$request.AddRange($offset)}
        $response=$request.GetResponse()
        $append=$offset -gt 0 -and [int]$response.StatusCode -eq 206
        $mode=if($append){[IO.FileMode]::Append}else{[IO.FileMode]::Create}
        $outputStream=New-Object IO.FileStream($path,$mode,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        $inputStream=$response.GetResponseStream()
        $buffer=New-Object byte[] 131072
        $reported=$outputStream.Length
        while(($read=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0){
            $outputStream.Write($buffer,0,$read)
            if($outputStream.Length-$reported -gt 10000000){$reported=$outputStream.Length;Write-Output "$Destination : $reported / $ExpectedSize bytes"}
        }
    }catch{Write-Output ('Retrying interrupted download: '+$_.Exception.Message)}
    finally{if($outputStream){$outputStream.Dispose()};if($inputStream){$inputStream.Dispose()};if($response){$response.Dispose()}}
}
throw 'Download could not be completed after retries'
