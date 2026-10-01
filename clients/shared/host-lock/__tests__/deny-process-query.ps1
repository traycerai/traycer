param([Parameter(Mandatory=$true)][int]$TargetPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TraycerProcDacl {
  const uint WRITE_DAC = 0x00040000;
  const uint READ_CONTROL = 0x00020000;
  const uint QUERY = 0x0400;
  const uint QUERY_LIMITED = 0x1000;
  const uint TOKEN_QUERY = 0x0008;
  const uint SE_KERNEL_OBJECT = 6;
  const uint DACL_SECURITY_INFORMATION = 4;
  const uint DENY_ACCESS = 3;
  const uint NO_INHERITANCE = 0;
  const uint TRUSTEE_IS_SID = 0;
  const uint TRUSTEE_IS_USER = 1;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  struct TRUSTEE { public IntPtr pMultipleTrustee; public int MultipleTrusteeOperation; public int TrusteeForm; public int TrusteeType; public IntPtr ptstrName; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  struct EXPLICIT_ACCESS { public uint grfAccessPermissions; public uint grfAccessMode; public uint grfInheritance; public TRUSTEE Trustee; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr b, int l, out int r);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Auto)] static extern int SetEntriesInAcl(uint c, ref EXPLICIT_ACCESS e, IntPtr o, out IntPtr n);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint SetSecurityInfo(IntPtr h, uint ot, uint si, IntPtr ow, IntPtr g, IntPtr d, IntPtr s);
  public static bool DenyQuery(int pid) {
    IntPtr proc = OpenProcess(WRITE_DAC | READ_CONTROL, false, pid);
    if (proc == IntPtr.Zero) return false;
    IntPtr tok; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out tok)) { CloseHandle(proc); return false; }
    int need; GetTokenInformation(tok, 1, IntPtr.Zero, 0, out need);
    IntPtr buf = Marshal.AllocHGlobal(need);
    if (!GetTokenInformation(tok, 1, buf, need, out need)) { Marshal.FreeHGlobal(buf); CloseHandle(tok); CloseHandle(proc); return false; }
    IntPtr sid = Marshal.ReadIntPtr(buf);
    EXPLICIT_ACCESS ea = new EXPLICIT_ACCESS();
    ea.grfAccessPermissions = QUERY | QUERY_LIMITED;
    ea.grfAccessMode = DENY_ACCESS; ea.grfInheritance = NO_INHERITANCE;
    ea.Trustee.TrusteeForm = (int)TRUSTEE_IS_SID; ea.Trustee.TrusteeType = (int)TRUSTEE_IS_USER; ea.Trustee.ptstrName = sid;
    IntPtr newDacl;
    if (SetEntriesInAcl(1, ref ea, IntPtr.Zero, out newDacl) != 0) { Marshal.FreeHGlobal(buf); CloseHandle(tok); CloseHandle(proc); return false; }
    uint st = SetSecurityInfo(proc, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, newDacl, IntPtr.Zero);
    Marshal.FreeHGlobal(buf); CloseHandle(tok); CloseHandle(proc);
    return st == 0;
  }
}
'@
if (-not [TraycerProcDacl]::DenyQuery($TargetPid)) { exit 2 }
try {
  $null = (Get-Process -Id $TargetPid).get_StartTime()
  exit 3
} catch {
  $reason = $_.Exception
  while ($null -ne $reason -and -not ($reason -is [System.ComponentModel.Win32Exception])) {
    $reason = $reason.InnerException
  }
  if ($null -eq $reason -or $reason.NativeErrorCode -ne 5) { exit 4 }
}
$row = Get-WmiObject Win32_Process -Filter "ProcessId = $TargetPid"
if ($null -eq $row -or $null -eq $row.CreationDate) { exit 5 }
"$TargetPid|$([string]$row.CreationDate)"
