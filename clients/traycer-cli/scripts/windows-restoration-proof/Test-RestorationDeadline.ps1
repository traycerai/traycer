# The Watchdog parameter set runs the Windows-only launch and write fault tests.
# The Full parameter set also needs the separate disposable Scheduler fixture.
[CmdletBinding(DefaultParameterSetName='Watchdog')]
param(
    [Parameter(Mandatory, ParameterSetName='Watchdog')] [string] $Repo,
    [Parameter(Mandatory, ParameterSetName='Watchdog')] [ValidatePattern('^[a-f0-9]{40}$')] [string] $Head,
    [Parameter(Mandatory, ParameterSetName='Full')] [string] $ProofExe,
    [Parameter(Mandatory, ParameterSetName='Full')] [string] $CliExe,
    [Parameter(ParameterSetName='Full')] [ValidateSet('Logon', 'Boot')] [string] $Mode = 'Logon',
    [Parameter(ParameterSetName='Full')] [ValidatePattern('^[a-f0-9]{32}$')] [string] $BootFixtureId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([IO.Path]::DirectorySeparatorChar -ne '\') { throw 'Run this proof in Windows.' }

if ($PSCmdlet.ParameterSetName -eq 'Watchdog') {
    $checkout = (Get-Item -LiteralPath $Repo).FullName
    $current = & git -C $checkout rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0 -or $current -cne $Head) { throw 'The checkout does not match the requested commit.' }
    if (@(& git -C $checkout status --porcelain --untracked-files=no).Count -ne 0 -or $LASTEXITCODE -ne 0) {
        throw 'Use a clean checkout of the requested commit.'
    }
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("traycer-restore-watchdog-" + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($scratch)
    try {
        $reportPath = Join-Path $scratch 'result.json'
        Push-Location -LiteralPath (Join-Path $checkout 'clients/traycer-cli')
        try {
            & bun x vitest run 'src/upgrade/__tests__/finalize-helper-launch.win32.test.ts' `
                -t 'ends a hung (launch|receipt) without a late receipt' --reporter=json --outputFile $reportPath `
                *> (Join-Path $scratch 'vitest.log')
            $testStatus = $LASTEXITCODE
        } finally { Pop-Location }
        if ($testStatus -ne 0 -or -not [IO.File]::Exists($reportPath)) {
            throw 'The native watchdog tests failed.'
        }
        $result = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
        $assertions = @($result.testResults | ForEach-Object { $_.assertionResults })
        foreach ($fault in @('launch', 'receipt')) {
            $title = "ends a hung $fault without a late receipt"
            $passing = @($assertions | Where-Object { $_.title -ceq $title -and $_.status -ceq 'passed' })
            if ($passing.Count -ne 1) { throw "FAIL $title" }
            [Console]::WriteLine("PASS $title")
        }
    } finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
    return
}

$proof = (Get-Item -LiteralPath $ProofExe).FullName
$cli = (Get-Item -LiteralPath $CliExe).FullName
if ([IO.Path]::GetFileName($proof) -cne 'traycer-win-restore-proof.exe') {
    throw 'Pass the test-only restoration proof executable.'
}
if ($Mode -eq 'Boot' -and -not $BootFixtureId) {
    throw 'Boot requires a disposable fixture provisioned by a VM administrator.'
}
if ($Mode -eq 'Logon' -and $BootFixtureId) { throw 'A boot fixture is valid only in Boot mode.' }

$id = if ($BootFixtureId) { $BootFixtureId } else { [Guid]::NewGuid().ToString('N') }
$taskPath = '\Traycer\'
$task = "Host-Dev-Restoreproof-$id"
$description = "Traycer Host (Dev restoreproof-$id)"
$root = Join-Path ([IO.Path]::GetTempPath()) "traycer-win-restore-$id"
$marker = Join-Path $root 'fixture.id'
$existing = Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue
if ($Mode -eq 'Boot') {
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

try {
    $out = Join-Path $root ("deadline-result-" + [Guid]::NewGuid().ToString('N') + '.json')
    $arguments = @('--case', 'deadline', '--root', $root, '--task', ($taskPath + $task),
        '--mode', $Mode, '--cli', $cli, '--result', $out)
    $quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath $proof -ArgumentList $quotedArguments -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $root 'proof.stdout') -RedirectStandardError (Join-Path $root 'proof.stderr')
    try {
        if (-not $process.WaitForExit(900000)) {
            try { $process.Kill() } catch {}
            throw 'The restoration proof did not finish within its outer test deadline.'
        }
        if ($process.ExitCode -ne 0 -or -not [IO.File]::Exists($out)) { throw 'The restoration proof process failed.' }
    } finally { $process.Dispose() }
    $report = [IO.File]::ReadAllText($out) | ConvertFrom-Json
    foreach ($name in @('coldRecovered', 'coldElapsedMs', 'coldStartBudgetMs', 'parentExitMs', 'launchMs', 'manifestMs', 'receiptMs')) {
        if ($null -eq $report.PSObject.Properties[$name]) { throw 'A required restoration assertion is missing.' }
    }
    Assert-Proof ($report.coldRecovered -and $report.coldStartBudgetMs -eq 224000 -and
        $report.coldElapsedMs -gt 0 -and $report.coldElapsedMs -le $report.coldStartBudgetMs) "cold $Mode recovery served in $($report.coldElapsedMs) ms"
    $outerFaultControlMs = 45000
    Assert-Proof ($report.parentExitMs -gt 0 -and $report.parentExitMs -le $outerFaultControlMs) "blocked parent exit reached one guarded start in $($report.parentExitMs) ms"
    Assert-Proof ($report.launchMs -gt 0 -and $report.launchMs -le $outerFaultControlMs) "blocked swap launch reached one guarded start in $($report.launchMs) ms"
    Assert-Proof ($report.manifestMs -gt 0 -and $report.manifestMs -le $outerFaultControlMs) "blocked manifest reached one guarded start in $($report.manifestMs) ms"
    Assert-Proof ($report.receiptMs -gt 0 -and $report.receiptMs -le $outerFaultControlMs) "blocked receipt warned and published no late result in $($report.receiptMs) ms"
} finally {
    $owned = Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue
    try {
        if ($null -ne $owned) {
            if ($owned.Description -cne $description) { throw 'The fixture task identity changed.' }
            Stop-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskPath $taskPath -TaskName $task -Confirm:$false
        }
    } finally {
        if ([IO.File]::Exists($marker) -and [IO.File]::ReadAllText($marker) -ceq $id) {
            Remove-Item -LiteralPath $root -Recurse -Force
        }
    }
}
