param(
    [Parameter(Mandatory)] [ValidateSet('register', 'disable', 'remove', 'suspend', 'resume')] [string] $Action,
    [Parameter(Mandatory)] [string] $Root,
    [int] $RestartPid
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (((Get-Item -LiteralPath $Root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The disposable scheduler fixture must be a real directory.'
}
$id = [IO.File]::ReadAllText((Join-Path $Root 'fixture.id'))
if ($id -cnotmatch '^[a-f0-9]{32}$' -or
    [IO.Path]::GetFileName($Root) -cne "traycer-win-restore-$id") {
    throw 'The disposable scheduler fixture path is invalid.'
}
if ($Action -in @('suspend', 'resume')) {
    if ($RestartPid -le 0) { throw 'A disposable restart process is required.' }
    $scratch = Join-Path $Root 'scratch'
    $arms = @(Get-ChildItem -LiteralPath $scratch -Filter '*.armed' -File |
        Where-Object { $_.Name -cmatch "^traycer-cli-finalize-dev-[0-9]+-$RestartPid-[a-f0-9]+\.armed$" })
    if ($arms.Count -ne 1) { throw 'The disposable helper arm was not identified.' }
    $helperPid = [int] [IO.File]::ReadAllText($arms[0].FullName)
    $script = [IO.Path]::ChangeExtension($arms[0].FullName, '.ps1')
    $listed = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$helperPid"
    if ($null -eq $listed -or -not $listed.CommandLine.Contains('"' + $script + '"')) {
        throw 'The disposable helper process does not own the arm.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DisposableHelper {
    [DllImport("ntdll.dll")]
    public static extern int NtSuspendProcess(IntPtr process);
    [DllImport("ntdll.dll")]
    public static extern int NtResumeProcess(IntPtr process);
}
'@
    $process = [Diagnostics.Process]::GetProcessById($helperPid)
    try {
        $result = if ($Action -eq 'suspend') {
            [DisposableHelper]::NtSuspendProcess($process.Handle)
        } else {
            [DisposableHelper]::NtResumeProcess($process.Handle)
        }
        if ($result -ne 0) { throw 'The disposable helper fault could not be controlled.' }
    } finally { $process.Dispose() }
    return
}
$taskPath = '\Traycer\'
$name = "Host-Dev-Restoreproof-$id"
$description = "Traycer Host (Dev restoreproof-$id)"
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $name -ErrorAction SilentlyContinue
if ($Action -eq 'register') {
    if ($null -ne $task) { throw 'The disposable scheduler task already exists.' }
    $xml = [IO.File]::ReadAllText((Join-Path $Root 'task.xml'))
    [xml] $definition = $xml
    if ($definition.Task.RegistrationInfo.Description -cne $description) {
        throw 'The disposable scheduler definition has the wrong identity.'
    }
    Register-ScheduledTask -TaskPath $taskPath -TaskName $name -Xml $xml | Out-Null
    return
}
if ($null -eq $task -and $Action -eq 'remove') { return }
if ($null -eq $task -or $task.Description -cne $description) {
    throw 'The disposable scheduler task could not be identified.'
}
if ($task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
if ($Action -eq 'disable') {
    Disable-ScheduledTask -InputObject $task | Out-Null
} elseif ($Action -eq 'remove') {
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
}
