# Draft for the disposable Scheduler proof. Use the test-only binaries from one build.
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ProofExe,
    [Parameter(Mandatory)] [string] $CliExe,
    [ValidateSet('Logon', 'Boot')] [string] $Mode = 'Logon',
    [ValidatePattern('^[a-f0-9]{32}$')] [string] $BootFixtureId,
    [string] $OldCliExe,
    [switch] $ColdOnly,
    [switch] $PrepareBoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([IO.Path]::DirectorySeparatorChar -ne '\') { throw 'Run this proof in Windows.' }
$proof = (Get-Item -LiteralPath $ProofExe).FullName
$cli = (Get-Item -LiteralPath $CliExe).FullName
if ([IO.Path]::GetFileName($proof) -cne 'traycer-win-restore-proof.exe') {
    throw 'Pass the test-only restoration proof executable.'
}
$old = if ($OldCliExe) { (Get-Item -LiteralPath $OldCliExe).FullName } else { $null }
if ($Mode -eq 'Boot' -and -not $BootFixtureId) {
    throw 'Boot requires a disposable fixture provisioned by a VM administrator.'
}
if ($Mode -eq 'Logon' -and $BootFixtureId) { throw 'A boot fixture is valid only in Boot mode.' }
if ($PrepareBoot -and $Mode -ne 'Boot') { throw 'Only a boot fixture needs preparation.' }

$id = if ($BootFixtureId) { $BootFixtureId } else { [Guid]::NewGuid().ToString('N') }
$taskPath = '\Traycer\'
$task = "Host-Dev-Restoreproof-$id"
$description = "Traycer Host (Dev restoreproof-$id)"
$root = Join-Path ([IO.Path]::GetTempPath()) "traycer-win-restore-$id"
$marker = Join-Path $root 'fixture.id'
$existing = Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue
if ($Mode -eq 'Boot' -and -not $PrepareBoot) {
    if ($null -eq $existing -or $existing.Description -cne $description -or
        -not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker) -cne $id) {
        throw 'The disposable boot task and folder do not match.'
    }
} else {
    if ($null -ne $existing -or [IO.Directory]::Exists($root)) { throw 'The fresh fixture name is occupied.' }
    [void][IO.Directory]::CreateDirectory($root)
    [IO.File]::WriteAllText($marker, $id)
}

if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The fixture folder must not be a reparse point.'
}

function Assert-Proof([bool] $Condition, [string] $Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    [Console]::WriteLine("PASS $Name")
}

$keepPrepared = $false
try {
    $out = Join-Path $root ("freshness-result-" + [Guid]::NewGuid().ToString('N') + '.json')
    $case = if ($PrepareBoot) { 'prepare' } elseif ($ColdOnly) { 'cold' } else { 'freshness' }
    $arguments = @('--case', $case, '--root', $root, '--task', ($taskPath + $task),
        '--mode', $Mode, '--cli', $cli, '--result', $out)
    if ($old) { $arguments += @('--old-cli', $old) }
    $quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath $proof -ArgumentList $quotedArguments -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $root 'proof.stdout') -RedirectStandardError (Join-Path $root 'proof.stderr')
    try {
        if (-not $process.WaitForExit(450000)) {
            try { $process.Kill() } catch {}
            throw 'The restoration proof did not finish within its outer test deadline.'
        }
        if ($process.ExitCode -ne 0) { throw 'The restoration proof process failed.' }
    } finally { $process.Dispose() }
    if ($PrepareBoot) {
        $xml = Join-Path $root 'task.xml'
        if (-not [IO.File]::Exists($xml)) { throw 'The fixture task definition is missing.' }
        $keepPrepared = $true
        [Console]::WriteLine("Prepared disposable task $taskPath$task from $xml")
        return
    }
    if (-not [IO.File]::Exists($out)) { throw 'The restoration proof result is missing.' }
    $report = [IO.File]::ReadAllText($out) | ConvertFrom-Json
    if ($ColdOnly) {
        Assert-Proof ($report.coldRecovered -and $report.coldElapsedMs -gt 0 -and
            $report.coldElapsedMs -le $report.coldStartBudgetMs) "cold $Mode recovery served in $($report.coldElapsedMs) ms"
        return
    }
    foreach ($name in @('staleRestored', 'unreadyRestored', 'freshRestored', 'expectedGenerationMatched', 'wrongGenerationRefused', 'disabledRefused', 'disabledTaskStillDisabled')) {
        if ($null -eq $report.PSObject.Properties[$name]) { throw 'A required restoration assertion is missing.' }
    }
    Assert-Proof (-not $report.staleRestored) 'draining runtime refused'
    Assert-Proof (-not $report.unreadyRestored) 'fresh unready runtime refused'
    Assert-Proof ($report.wrongGenerationRefused) 'same-version runtime from a different generation refused'
    Assert-Proof ($report.freshRestored -and $report.expectedGenerationMatched) 'fresh serving runtime accepted'
    Assert-Proof ($report.disabledRefused -and $report.disabledTaskStillDisabled) 'disabled task stayed disabled'
    if ($old) { Assert-Proof ($report.pendingWrittenByOldCli -eq $true) 'used a pending record written by the old CLI' }
} finally {
    $owned = Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue
    try {
        if ($null -ne $owned) {
            if ($owned.Description -cne $description) { throw 'The fixture task identity changed.' }
            Stop-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskPath $taskPath -TaskName $task -Confirm:$false
        }
    } finally {
        if (-not $keepPrepared -and [IO.File]::Exists($marker) -and [IO.File]::ReadAllText($marker) -ceq $id) {
            Remove-Item -LiteralPath $root -Recurse -Force
        }
    }
}
