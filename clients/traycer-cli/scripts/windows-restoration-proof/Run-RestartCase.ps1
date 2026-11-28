[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('cold', 'legacy', 'parent-exit', 'incumbent-stays', 'in-job', 'busy', 'disabled', 'receipt')] [string] $Case,
    [Parameter(Mandatory)] [ValidateSet('Logon', 'Boot')] [string] $Mode,
    [Parameter(Mandatory)] [string] $Kit
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'Proof-Process.ps1')
$kitPath = (Get-Item -LiteralPath $Kit).FullName
$proof = Join-Path $kitPath 'traycer-win-restore-proof.exe'
$cli = Join-Path $kitPath 'traycer.exe'
$id = [Guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "traycer-win-restore-$id"
$task = "\Traycer\Host-Dev-Restoreproof-$id"
if ([IO.Directory]::Exists($root)) { throw 'The disposable fixture path already exists.' }
[void][IO.Directory]::CreateDirectory($root)
[IO.File]::WriteAllText((Join-Path $root 'fixture.id'), $id)
$common = @('--root', $root, '--task', $task, '--mode', $Mode, '--cli', $cli)
try {
    if ($Mode -eq 'Boot') {
        Invoke-ProofProcess -File $proof -Arguments ($common + @('--case', 'prepare')) -Case 'prepare boot' -TimeoutMilliseconds 60000
        & (Join-Path $kitPath 'Set-ProofTask.ps1') -Action register -Root $root
    }
    $arguments = $common + @('--case', $Case)
    if ($Case -eq 'legacy') {
        $arguments += @('--old-cli', (Join-Path $kitPath 'traycer-win-restore-legacy-writer.exe'))
    }
    Invoke-ProofProcess -File $proof -Arguments $arguments -Case "$Case $Mode" -TimeoutMilliseconds 680000
} finally {
    try {
        & (Join-Path $kitPath 'Set-ProofTask.ps1') -Action remove -Root $root
    } finally {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
