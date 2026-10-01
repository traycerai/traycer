# Runs one command with SeDebugPrivilege REMOVED from this process's token,
# so the command and everything it starts inherit a token that cannot
# re-enable it.
#
# Disabling is not enough. A disabled privilege is still held, and a fresh
# `powershell` enables SeDebug during its own startup (measured on a Windows
# VM: Enabled before its first command, under an elevated parent that had
# disabled it). With SeDebug enabled a process DACL binds nothing, so on an
# elevated runner no process has a denied start-time read and the
# denied-read tests would have nothing to prove.
#
# Usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass
#   -File run-without-sedebug.ps1 <command> [<argument>...]
# Arguments must not start with '-': PowerShell would bind them to this
# script's own parameters.
# Exit codes: the command's own; 6 = the TOKEN_PRIVILEGES layout is not the
# native 16 bytes; 7 = a token call failed; 8 = SeDebugPrivilege is still
# listed for a child after the removal.
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Command,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TraycerTokenPrivilege {
  const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
  const uint TOKEN_QUERY = 0x0008;
  const uint SE_PRIVILEGE_REMOVED = 0x00000004;
  // Native layout: DWORD PrivilegeCount; LUID_AND_ATTRIBUTES Privileges[1],
  // where LUID is two DWORDs at 4-byte alignment - offset 4, 16 bytes
  // total. Without Pack=4 the CLR aligns `long` to 8, so SizeOf is 24 and
  // the LUID lands at offset 8: AdjustTokenPrivileges then reads a garbage
  // LUID.
  [StructLayout(LayoutKind.Sequential, Pack=4)] struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public long Luid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string s, string n, out long l);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr t, bool d, ref TOKEN_PRIVILEGES n, int l, IntPtr p, IntPtr r);
  public static int RemoveDebug() {
    if (Marshal.SizeOf(typeof(TOKEN_PRIVILEGES)) != 16) return 6;
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out tok)) return 7;
    TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
    tp.PrivilegeCount = 1; tp.Attributes = SE_PRIVILEGE_REMOVED;
    if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out tp.Luid)) { CloseHandle(tok); return 7; }
    // TRUE with GetLastError 1300 (ERROR_NOT_ALL_ASSIGNED) means the token
    // never held it - an unelevated runner - which is the goal already. The
    // whoami check after this call is what decides.
    bool adjusted = AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    CloseHandle(tok);
    return adjusted ? 0 : 7;
  }
}
'@
$removed = [TraycerTokenPrivilege]::RemoveDebug()
if ($removed -ne 0) { exit $removed }
# A child inherits this token, so what whoami lists is what the command's
# processes will hold. Privilege names are not localised.
$held = whoami /priv /fo csv /nh | Select-String -SimpleMatch '"SeDebugPrivilege"'
if ($null -ne $held) {
  [Console]::Error.WriteLine("run-without-sedebug: SeDebugPrivilege is still held after the removal")
  exit 8
}
& $Command @Arguments
exit $LASTEXITCODE
