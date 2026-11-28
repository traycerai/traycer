[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Kit,
    [Parameter(Mandatory)] [string] $Transcript,
    [switch] $DemandStartRecordingPassed
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'Proof-Process.ps1')
$transcriptPath = [IO.Path]::GetFullPath($Transcript)
$kitPath = (Get-Item -LiteralPath $Kit).FullName
$powerShell = Join-Path $PSHOME 'powershell.exe'
$signature = [Guid]::NewGuid().ToString('N')
$probe = "Traycer-Restoration-Logon-$signature"
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) $probe
$marker = Join-Path $probeRoot 'interactive-task-started'
[IO.File]::WriteAllText($transcriptPath, '', [Text.UTF8Encoding]::new($false))
Write-ProofLine 'Windows restoration proof' $transcriptPath
if ($DemandStartRecordingPassed) {
    Write-ProofLine 'PASS disabled and unreadable task issued no /Run (recording process runner)' $transcriptPath
}

function Invoke-Driver([string] $Case, [string] $Mode) {
    $driverArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $PSScriptRoot 'Run-RestartCase.ps1'), '-Kit', $kitPath, '-Case', $Case, '-Mode', $Mode)
    Invoke-ProofProcess -File $powerShell -Arguments $driverArgs -Case "$Case $Mode driver" `
        -TimeoutMilliseconds 520000 -TranscriptPath $transcriptPath
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
    $failures = [Collections.Generic.List[string]]::new()
    if ($canRunLogon) {
        foreach ($case in @('cold', 'legacy', 'parent-exit', 'busy', 'disabled', 'receipt')) {
            try { Invoke-Driver $case 'Logon' } catch { $failures.Add("$case Logon") }
        }
    } else {
        $message = 'Logon proof not run: no interactive task session'
        Write-ProofLine $message $transcriptPath
        $failures.Add($message)
    }
    try { Invoke-Driver 'cold' 'Boot' } catch { $failures.Add('cold Boot') }
    if ($failures.Count -gt 0) { throw ($failures -join '; ') }
} finally {
    if ($createdTaskFolder) {
        $folder = $scheduler.GetFolder('\Traycer')
        if ($folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) {
            $scheduler.GetFolder('\').DeleteFolder('Traycer', 0)
        }
    }
}
