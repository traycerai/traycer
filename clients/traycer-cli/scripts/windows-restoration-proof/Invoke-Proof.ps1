[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Kit,
    [Parameter(Mandatory)] [string] $Transcript,
    [switch] $DemandStartRecordingPassed
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$transcriptPath = [IO.Path]::GetFullPath($Transcript)
$kitPath = (Get-Item -LiteralPath $Kit).FullName
$cli = Join-Path $kitPath 'traycer.exe'
$proof = Join-Path $kitPath 'traycer-win-restore-proof.exe'
$legacy = Join-Path $kitPath 'traycer-win-restore-legacy-writer.exe'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$signature = [Guid]::NewGuid().ToString('N')
$probe = "Traycer-Restoration-Logon-$signature"
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) $probe
$marker = Join-Path $probeRoot 'interactive-task-started'
[IO.File]::WriteAllText($transcriptPath, "Windows restoration proof`r`n")
if ($DemandStartRecordingPassed) {
    'PASS disabled and unreadable task issued no /Run (recording process runner)' |
        Tee-Object -FilePath $transcriptPath -Append
}

function Invoke-Driver([string] $Driver, [string[]] $Options) {
    & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Driver) `
        -CliExe $cli -ProofExe $proof @Options 2>&1 | Tee-Object -FilePath $transcriptPath -Append
    if ($LASTEXITCODE -ne 0) { throw "Disposable driver failed: $Driver" }
}

function New-BootFixture([string] $Id) {
    Invoke-Driver 'Test-RestorationFreshness.ps1' @('-Mode', 'Boot', '-BootFixtureId', $Id, '-PrepareBoot')
    $root = Join-Path ([IO.Path]::GetTempPath()) "traycer-win-restore-$Id"
    $xml = Join-Path $root 'task.xml'
    & schtasks.exe /Create /TN "\Traycer\Host-Dev-Restoreproof-$Id" /XML $xml 2>&1 |
        Tee-Object -FilePath $transcriptPath -Append
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the disposable boot task.' }
}

try {
    [void][IO.Directory]::CreateDirectory($probeRoot)
    $principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $probeCommand = "[IO.File]::WriteAllText('$($marker.Replace("'", "''"))', 'started')"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeCommand))
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $principal
    $identity = New-ScheduledTaskPrincipal -UserId $principal -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $probe -Action $action -Trigger $trigger -Principal $identity | Out-Null
    try {
        Start-ScheduledTask -TaskName $probe
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not [IO.File]::Exists($marker) -and $clock.Elapsed.TotalSeconds -lt 15) {
            Start-Sleep -Milliseconds 100
        }
    } catch {
        # The task result or the missing marker, rather than an assumed
        # runner desktop mode, decides whether the Logon cases can run.
    }
    $canRunLogon = [IO.File]::Exists($marker)
} finally {
    if (Get-ScheduledTask -TaskName $probe -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $probe -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $probe -Confirm:$false
    }
    if ([IO.Directory]::Exists($probeRoot)) {
        Remove-Item -LiteralPath $probeRoot -Recurse -Force
    }
}

$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$createdTaskFolder = $false
try {
    $null = $scheduler.GetFolder('\Traycer')
} catch {
    $null = $scheduler.GetFolder('\').CreateFolder('Traycer', $null)
    $createdTaskFolder = $true
}
try {
    if ($canRunLogon) {
        Invoke-Driver 'Test-RestorationDeadline.ps1' @()
        Invoke-Driver 'Test-RestorationFreshness.ps1' @()
        Invoke-Driver 'Test-RestorationFreshness.ps1' @('-OldCliExe', $legacy)
    } else {
        'Logon proof not run: no interactive task session' | Tee-Object -FilePath $transcriptPath -Append
    }

    $deadlineId = [Guid]::NewGuid().ToString('N')
    New-BootFixture $deadlineId
    Invoke-Driver 'Test-RestorationDeadline.ps1' @('-Mode', 'Boot', '-BootFixtureId', $deadlineId)
    $freshnessId = [Guid]::NewGuid().ToString('N')
    New-BootFixture $freshnessId
    Invoke-Driver 'Test-RestorationFreshness.ps1' @('-Mode', 'Boot', '-BootFixtureId', $freshnessId)

    if (-not $canRunLogon) { throw 'Logon proof not run: no interactive task session' }
} finally {
    if ($createdTaskFolder) {
        $folder = $scheduler.GetFolder('\Traycer')
        if ($folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) {
            $scheduler.GetFolder('\').DeleteFolder('Traycer', 0)
        }
    }
}
