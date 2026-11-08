function Resolve-WorkspaceGeneratedPath {
    param([Parameter(Mandatory)][string]$WorkspaceRoot, [Parameter(Mandatory)][string]$Path)
    $taskRoot = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $taskPath = [IO.Path]::GetFullPath($Path)
    $taskPrefix = $taskRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $taskPath.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Generated download target must stay inside the workspace' }
    $taskCurrent = $taskRoot
    foreach ($taskPart in $taskPath.Substring($taskPrefix.Length).Split([char[]]'\/')) {
        $taskCurrent = Join-Path $taskCurrent $taskPart
        if (Test-Path -LiteralPath $taskCurrent) {
            $taskItem = Get-Item -LiteralPath $taskCurrent -Force
            if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Generated download targets cannot traverse links or junctions' }
        }
    }
    return $taskPath
}

function Remove-WorkspaceGeneratedItem {
    param([Parameter(Mandatory)][string]$WorkspaceRoot, [Parameter(Mandatory)][string]$Path, [switch]$Recurse)
    $taskSafePath = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $Path
    if ($Recurse -and (Test-Path -LiteralPath $taskSafePath -PathType Container)) {
        $taskPending = New-Object 'Collections.Generic.Stack[string]'
        $taskPending.Push($taskSafePath)
        while ($taskPending.Count) {
            foreach ($taskChild in Get-ChildItem -LiteralPath $taskPending.Pop() -Force) {
                [void](Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $taskChild.FullName)
                if ($taskChild.PSIsContainer) { $taskPending.Push($taskChild.FullName) }
            }
        }
    }
    if (Test-Path -LiteralPath $taskSafePath) { Remove-Item -LiteralPath $taskSafePath -Force -Recurse:$Recurse -ErrorAction Stop }
}

function Test-VerifiedDownloadFile {
    param([string]$Path, [string]$Sha256, [scriptblock]$Validate)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        if ($Sha256 -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Sha256) { return $false }
        if ($Validate) {
            $taskValidation = @(& $Validate $Path)
            if ($taskValidation.Count -ne 1 -or $taskValidation[0] -isnot [bool] -or -not $taskValidation[0]) { return $false }
        }
        return $true
    } catch { return $false }
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory)][string]$WorkspaceRoot,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Destination,
        [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
        [scriptblock]$Validate,
        [ValidateRange(1, 3)][int]$Attempts = 2,
        [scriptblock]$Transfer = { param($Uri, $OutFile) Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -TimeoutSec 300 }
    )
    $ErrorActionPreference = 'Stop'
    if (-not $Sha256 -and -not $Validate) { throw 'A download must have a checksum or a content validator' }
    $taskFinal = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $Destination
    if (Test-Path -LiteralPath $taskFinal -PathType Container) { throw 'The download destination must be a file' }
    if (Test-VerifiedDownloadFile -Path $taskFinal -Sha256 $Sha256 -Validate $Validate) { return $taskFinal }
    # A bad generated cache must not poison every subsequent setup attempt.
    Remove-WorkspaceGeneratedItem -WorkspaceRoot $WorkspaceRoot -Path $taskFinal
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $taskFinal))
    for ($taskAttempt = 1; $taskAttempt -le $Attempts; $taskAttempt++) {
        $taskTemporary = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path ($taskFinal + '.' + [guid]::NewGuid().ToString('N') + '.download')
        try {
            & $Transfer $Uri $taskTemporary | Out-Null
            if (-not (Test-VerifiedDownloadFile -Path $taskTemporary -Sha256 $Sha256 -Validate $Validate)) { throw 'Downloaded file failed verification' }
            [void](Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $taskFinal)
            if (Test-Path -LiteralPath $taskFinal) { [IO.File]::Replace($taskTemporary, $taskFinal, $null) }
            else { [IO.File]::Move($taskTemporary, $taskFinal) }
            return $taskFinal
        } catch {
            if ($taskAttempt -eq $Attempts) { throw ('Could not verify ' + [IO.Path]::GetFileName($taskFinal) + ' after ' + $Attempts + ' attempt(s): ' + $_.Exception.Message) }
        } finally {
            Remove-WorkspaceGeneratedItem -WorkspaceRoot $WorkspaceRoot -Path $taskTemporary
        }
    }
}

function Test-SpeechModelMetadata {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Name)
    try {
        if ((Get-Item -LiteralPath $Path).Length -gt 67108864) { return $false }
        $taskUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $taskText = $taskUtf8.GetString([IO.File]::ReadAllBytes($Path))
        if ($Name -eq 'vocabulary.txt') { return $taskText.Trim().Length -gt 0 -and ($taskText -split "`n").Count -ge 1024 }
        # Unlike ConvertFrom-Json in Windows PowerShell, this accepts tokenizer
        # vocabularies containing distinct case-sensitive keys such as a and A.
        Add-Type -AssemblyName System.Web.Extensions
        $taskParser = New-Object Web.Script.Serialization.JavaScriptSerializer
        $taskParser.MaxJsonLength = 67108864
        $taskParser.RecursionLimit = 1024
        $taskJson = $taskParser.DeserializeObject($taskText)
        if ($taskJson -isnot [Collections.IDictionary] -or $taskJson.Count -eq 0) { return $false }
        if ($Name -eq 'tokenizer.json') {
            return $taskJson.ContainsKey('model') -and $taskJson['model'] -is [Collections.IDictionary] -and $taskJson['model'].ContainsKey('vocab') -and $taskJson['model']['vocab'] -is [Collections.IDictionary] -and $taskJson['model']['vocab'].Count -gt 0
        }
        return $Name -eq 'config.json' -and $taskJson.ContainsKey('suppress_ids') -and $taskJson['suppress_ids'] -is [Array]
    } catch { return $false }
}

function Install-VerifiedRuntimeArchive {
    param([Parameter(Mandatory)][string]$WorkspaceRoot, [Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination)
    $ErrorActionPreference = 'Stop'
    $taskArchive = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $Archive
    $taskFinal = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $Destination
    $taskStaging = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path ($taskFinal + '.' + [guid]::NewGuid().ToString('N') + '.staging')
    $taskPrevious = Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path ($taskFinal + '.' + [guid]::NewGuid().ToString('N') + '.previous')
    try {
        Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskStaging -Force
        if (-not (Test-Path -LiteralPath (Join-Path $taskStaging 'electron.exe') -PathType Leaf)) { throw 'The verified runtime archive has no desktop executable' }
        [void](Resolve-WorkspaceGeneratedPath -WorkspaceRoot $WorkspaceRoot -Path $taskFinal)
        if (Test-Path -LiteralPath $taskFinal) { [IO.Directory]::Move($taskFinal, $taskPrevious) }
        try { [IO.Directory]::Move($taskStaging, $taskFinal) }
        catch { if (-not (Test-Path -LiteralPath $taskFinal) -and (Test-Path -LiteralPath $taskPrevious)) { [IO.Directory]::Move($taskPrevious, $taskFinal) }; throw }
        Remove-WorkspaceGeneratedItem -WorkspaceRoot $WorkspaceRoot -Path $taskPrevious -Recurse
    } finally {
        Remove-WorkspaceGeneratedItem -WorkspaceRoot $WorkspaceRoot -Path $taskStaging -Recurse
    }
}
