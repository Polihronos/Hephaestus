import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const execFileAsync=promisify(execFile),windows={skip:process.platform!=='win32'};
async function fixture(body){
 const root=await mkdtemp(join(tmpdir(),'hephaestus-downloads-'));
 try{
  const script=join(root,'fixture.ps1');
  await writeFile(script,`param([string]$Helper,[string]$FixtureRoot,[string]$SourceRoot)\n$ErrorActionPreference='Stop'\n. $Helper\nfunction Assert-Task { param($Condition,[string]$Message) if(-not $Condition){throw $Message} }\nfunction Write-TaskFile { param([string]$Path,[string]$Text) [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path)); [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false))) }\n${body}\nWrite-Output 'LOCAL_DOWNLOAD_FIXTURE_PASSED'\n`);
  const result=await execFileAsync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Helper',resolve('scripts/verified-download.ps1'),'-FixtureRoot',root,'-SourceRoot',process.cwd()],{timeout:20000,windowsHide:true,maxBuffer:1024*1024});
  assert.match(result.stdout,/LOCAL_DOWNLOAD_FIXTURE_PASSED/);
 }finally{await rm(root,{recursive:true,force:true});}
}

test('verified downloads recover corrupt caches, reject bad transfers and reuse only checked data',windows,()=>fixture(`
$taskSource=Join-Path $FixtureRoot 'source.bin'; Write-TaskFile $taskSource 'verified payload'
$taskHash=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash
$taskDestination=Join-Path $FixtureRoot 'cache[1].bin'; Write-TaskFile $taskDestination 'corrupt cache'
$script:TaskTransfers=0
$taskTransfer={param($Uri,$OutFile) $script:TaskTransfers++; if($script:TaskTransfers -eq 1){Write-TaskFile $OutFile 'bad response'}else{[IO.File]::Copy($taskSource,$OutFile)}}
$taskResult=Get-VerifiedDownload -WorkspaceRoot $FixtureRoot -Destination $taskDestination -Uri 'https://unused.invalid/file' -Sha256 $taskHash -Transfer $taskTransfer
Assert-Task ($script:TaskTransfers -eq 2) 'A bad cache or response prevented automatic recovery'
Assert-Task ([IO.File]::ReadAllText($taskResult) -eq 'verified payload') 'Unchecked bytes reached the final file'
Get-VerifiedDownload -WorkspaceRoot $FixtureRoot -Destination $taskDestination -Uri 'https://unused.invalid/file' -Sha256 $taskHash -Transfer {throw 'Valid cached data must not redownload'} | Out-Null
Assert-Task (@(Get-ChildItem -LiteralPath $FixtureRoot -Filter '*.download').Count -eq 0) 'Temporary download files leaked'
`));

test('interrupted transfers never promote partial bytes and a later retry needs no cleanup',windows,()=>fixture(`
$taskSource=Join-Path $FixtureRoot 'source.bin'; Write-TaskFile $taskSource 'complete payload'
$taskHash=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash
$taskDestination=Join-Path $FixtureRoot 'downloaded.bin'; $script:TaskTransfers=0; $taskFailed=$false
try { Get-VerifiedDownload -WorkspaceRoot $FixtureRoot -Destination $taskDestination -Uri 'https://unused.invalid/file' -Sha256 $taskHash -Transfer {param($Uri,$OutFile) $script:TaskTransfers++; Write-TaskFile $OutFile 'partial'; throw 'Transfer interrupted'} | Out-Null }catch{$taskFailed=$true}
Assert-Task $taskFailed 'Interrupted transfer unexpectedly succeeded'
Assert-Task ($script:TaskTransfers -eq 2) 'Transfer retry count is not bounded'
Assert-Task (-not (Test-Path -LiteralPath $taskDestination)) 'A partial final download was published'
Assert-Task (@(Get-ChildItem -LiteralPath $FixtureRoot -Filter '*.download').Count -eq 0) 'Incomplete temporary files remained'
Get-VerifiedDownload -WorkspaceRoot $FixtureRoot -Destination $taskDestination -Uri 'https://unused.invalid/file' -Sha256 $taskHash -Transfer {param($Uri,$OutFile) [IO.File]::Copy($taskSource,$OutFile)} | Out-Null
Assert-Task ([IO.File]::ReadAllText($taskDestination) -eq 'complete payload') 'A fresh retry could not recover'
`));

test('speech metadata validation catches malformed caches and accepts case-sensitive tokenizer vocabularies',windows,()=>fixture(`
$taskConfig=Join-Path $FixtureRoot 'config.json'; Write-TaskFile $taskConfig '<html>download failed</html>'
$taskConfigValidator={param($Path) Test-SpeechModelMetadata -Path $Path -Name 'config.json'}
Get-VerifiedDownload -WorkspaceRoot $FixtureRoot -Destination $taskConfig -Uri 'https://unused.invalid/config' -Validate $taskConfigValidator -Transfer {param($Uri,$OutFile) Write-TaskFile $OutFile ('{^suppress_ids^:[1,2]}'.Replace('^',[char]34))} | Out-Null
Assert-Task (Test-SpeechModelMetadata $taskConfig 'config.json') 'A malformed metadata cache could not recover'
Write-TaskFile $taskConfig ('{^error^:^not a model^}'.Replace('^',[char]34)); Assert-Task (-not (Test-SpeechModelMetadata $taskConfig 'config.json')) 'A server error JSON was accepted as model configuration'
$taskTokenizer=Join-Path $FixtureRoot 'tokenizer.json'; Write-TaskFile $taskTokenizer ('{^model^:{^vocab^:{^a^:1,^A^:2}}}'.Replace('^',[char]34))
Assert-Task (Test-SpeechModelMetadata $taskTokenizer 'tokenizer.json') 'Case-sensitive tokenizer keys were rejected'
Write-TaskFile $taskTokenizer ('{^model^:'.Replace('^',[char]34)); Assert-Task (-not (Test-SpeechModelMetadata $taskTokenizer 'tokenizer.json')) 'Truncated JSON was accepted'
$taskVocabulary=Join-Path $FixtureRoot 'vocabulary.txt'; Write-TaskFile $taskVocabulary 'partial'
Assert-Task (-not (Test-SpeechModelMetadata $taskVocabulary 'vocabulary.txt')) 'Truncated vocabulary was accepted'
Write-TaskFile $taskVocabulary ((1..1024 | ForEach-Object {'token'+$_}) -join [Environment]::NewLine)
Assert-Task (Test-SpeechModelMetadata $taskVocabulary 'vocabulary.txt') 'Complete vocabulary fixture was rejected'
`));

test('download cleanup cannot escape the workspace or follow a junction',windows,()=>fixture(`
$taskWorkspace=Join-Path $FixtureRoot 'workspace'; $taskOutside=Join-Path $FixtureRoot 'outside'; [void][IO.Directory]::CreateDirectory($taskWorkspace)
$taskOutsideFile=Join-Path $taskOutside 'keep.bin'; Write-TaskFile $taskOutsideFile 'keep this'
foreach($taskCandidate in @($taskOutsideFile,(Join-Path $taskWorkspace '..\\outside\\keep.bin'))){
 $taskRejected=$false;try { Get-VerifiedDownload -WorkspaceRoot $taskWorkspace -Destination $taskCandidate -Uri 'https://unused.invalid/file' -Sha256 ('0'*64) -Transfer {throw 'Transfer must not be called'} | Out-Null }catch{$taskRejected=$true}
 Assert-Task $taskRejected 'An outside-workspace target was allowed'
}
$taskLink=Join-Path $taskWorkspace 'linked'; New-Item -ItemType Junction -Path $taskLink -Target $taskOutside | Out-Null
$taskRejected=$false;try { Get-VerifiedDownload -WorkspaceRoot $taskWorkspace -Destination (Join-Path $taskLink 'keep.bin') -Uri 'https://unused.invalid/file' -Sha256 ('0'*64) -Transfer {throw 'Transfer must not be called'} | Out-Null }catch{$taskRejected=$true}
Assert-Task $taskRejected 'A junction target was allowed'; Assert-Task ([IO.File]::ReadAllText($taskOutsideFile) -eq 'keep this') 'Outside files were modified'
$taskGenerated=Join-Path $taskWorkspace 'generated'; [void][IO.Directory]::CreateDirectory($taskGenerated)
New-Item -ItemType Junction -Path (Join-Path $taskGenerated 'nested-link') -Target $taskOutside | Out-Null
$taskRejected=$false;try {Remove-WorkspaceGeneratedItem -WorkspaceRoot $taskWorkspace -Path $taskGenerated -Recurse}catch{$taskRejected=$true}
Assert-Task $taskRejected 'Recursive cleanup followed a nested junction'; Assert-Task ([IO.File]::ReadAllText($taskOutsideFile) -eq 'keep this') 'Recursive cleanup modified outside files'
`));

test('the runtime setup repairs unchecked installed files from a checksum-verified local archive',windows,()=>fixture(`
$taskProject=Join-Path $FixtureRoot 'checkout'; $taskScripts=Join-Path $taskProject 'scripts'; [void][IO.Directory]::CreateDirectory($taskScripts)
Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\\verified-download.ps1') -Destination $taskScripts
Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\\fetch-runtime.ps1') -Destination $taskScripts
$taskArchiveContents=Join-Path $FixtureRoot 'archive-content'; Write-TaskFile (Join-Path $taskArchiveContents 'electron.exe') 'verified executable fixture'
$global:TaskFixtureArchive=Join-Path $FixtureRoot 'runtime-fixture.zip'; Compress-Archive -LiteralPath (Join-Path $taskArchiveContents 'electron.exe') -DestinationPath $global:TaskFixtureArchive
$taskHash=(Get-FileHash -LiteralPath $global:TaskFixtureArchive -Algorithm SHA256).Hash
Write-TaskFile (Join-Path $taskProject 'node_modules\\electron\\package.json') ('{^version^:^1.2.3^}'.Replace('^',[char]34))
Write-TaskFile (Join-Path $taskProject 'node_modules\\electron\\checksums.json') (('{^electron-v1.2.3-win32-x64.zip^:^'+$taskHash+'^}').Replace('^',[char]34))
Write-TaskFile (Join-Path $taskProject '.runtime-downloads\\electron.zip') 'corrupt archive cache'
Write-TaskFile (Join-Path $taskProject 'node_modules\\electron\\dist\\electron.exe') 'unchecked executable'
$global:TaskRuntimeTransfers=0
function Invoke-WebRequest {param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec) Assert-Task ($Uri -eq 'https://github.com/electron/electron/releases/download/v1.2.3/electron-v1.2.3-win32-x64.zip') 'Runtime URL/version selection changed'; $global:TaskRuntimeTransfers++; [IO.File]::Copy($global:TaskFixtureArchive,$OutFile)}
& (Join-Path $taskScripts 'fetch-runtime.ps1') | Out-Null
Assert-Task ($global:TaskRuntimeTransfers -eq 1) 'Corrupt runtime archive was not replaced'
$taskInstalled=Join-Path $taskProject 'node_modules\\electron\\dist\\electron.exe'
Assert-Task ([IO.File]::ReadAllText($taskInstalled) -eq 'verified executable fixture') 'Unchecked executable remained installed'
Write-TaskFile $taskInstalled 'tampered executable'; & (Join-Path $taskScripts 'fetch-runtime.ps1') | Out-Null
Assert-Task ($global:TaskRuntimeTransfers -eq 1) 'Verified cached runtime unnecessarily redownloaded'
Assert-Task ([IO.File]::ReadAllText($taskInstalled) -eq 'verified executable fixture') 'Existing executable bypassed archive validation'
Assert-Task ([IO.File]::ReadAllText((Join-Path $taskProject 'node_modules\\electron\\path.txt')) -eq 'electron.exe') 'Runtime launch marker was not set'
`));

test('failed extraction preserves the prior runtime and removes incomplete staging',windows,()=>fixture(`
$taskArchive=Join-Path $FixtureRoot 'runtime.zip'; Write-TaskFile $taskArchive 'local archive fixture'
$taskDestination=Join-Path $FixtureRoot 'dist'; Write-TaskFile (Join-Path $taskDestination 'electron.exe') 'previous executable'
function Expand-Archive {param($LiteralPath,$DestinationPath,[switch]$Force) Write-TaskFile (Join-Path $DestinationPath 'electron.exe') 'partial extraction'; throw 'Extraction interrupted'}
$taskFailed=$false;try { Install-VerifiedRuntimeArchive -WorkspaceRoot $FixtureRoot -Archive $taskArchive -Destination $taskDestination }catch{$taskFailed=$true}
Assert-Task $taskFailed 'Interrupted extraction unexpectedly succeeded'
Assert-Task ([IO.File]::ReadAllText((Join-Path $taskDestination 'electron.exe')) -eq 'previous executable') 'The prior runtime was replaced by partial data'
Assert-Task (@(Get-ChildItem -LiteralPath $FixtureRoot -Directory -Filter '*.staging').Count -eq 0) 'Incomplete extraction staging remained'
`));

test('the speech setup repairs metadata but never publishes interrupted weights',windows,()=>fixture(`
$taskProject=Join-Path $FixtureRoot 'checkout'; $taskScripts=Join-Path $taskProject 'scripts'; [void][IO.Directory]::CreateDirectory($taskScripts)
Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\\verified-download.ps1') -Destination $taskScripts
Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\\fetch-speech-model.ps1') -Destination $taskScripts
$taskModel=Join-Path $taskProject 'speech\\models\\base.en'
foreach($taskName in @('config.json','tokenizer.json','vocabulary.txt','model.bin')){Write-TaskFile (Join-Path $taskModel $taskName) 'corrupt old cache'}
$global:TaskWeightTransfers=0
function Invoke-WebRequest {
 param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec)
 Assert-Task ($Uri.StartsWith('https://huggingface.co/Systran/faster-whisper-base.en/resolve/main/')) 'Speech model URL selection changed'
 switch([IO.Path]::GetFileName($Uri)){
  'config.json' {Write-TaskFile $OutFile ('{^suppress_ids^:[1,2]}'.Replace('^',[char]34))}
  'tokenizer.json' {Write-TaskFile $OutFile ('{^model^:{^vocab^:{^a^:1,^A^:2}}}'.Replace('^',[char]34))}
  'vocabulary.txt' {Write-TaskFile $OutFile ((1..1024 | ForEach-Object {'token'+$_}) -join [Environment]::NewLine)}
  'model.bin' {$global:TaskWeightTransfers++; Write-TaskFile $OutFile 'partial weights'; throw 'Transfer interrupted'}
  default {throw 'Unexpected download'}
 }
}
$taskFailed=$false;try { & (Join-Path $taskScripts 'fetch-speech-model.ps1') | Out-Null }catch{$taskFailed=$true}
Assert-Task $taskFailed 'Interrupted model setup unexpectedly succeeded'
Assert-Task ($global:TaskWeightTransfers -eq 2) 'Weights did not reach the bounded retry path'
foreach($taskName in @('config.json','tokenizer.json','vocabulary.txt')){Assert-Task (Test-SpeechModelMetadata (Join-Path $taskModel $taskName) $taskName) 'Metadata repair failed'}
Assert-Task (-not (Test-Path -LiteralPath (Join-Path $taskModel 'model.bin'))) 'Partial model weights were promoted'
Assert-Task (@(Get-ChildItem -LiteralPath $taskModel -Filter '*.download').Count -eq 0) 'Interrupted model temporary files remained'
`));
