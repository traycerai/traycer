import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ProcessIncarnationProbe } from "@traycer/protocol/config/data-migration-admission";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle/process-start-identity";
import { pathInsideRoot } from "../external-actions/ledger";

/**
 * Which processes are USING the source data root right now: a working
 * directory, an open file or folder handle, or an executable image inside it.
 * Quiescence requires none other than the coordinator itself, proven by
 * incarnation. The admission registry and the host's child-process
 * ledgers name the processes Traycer started; this census is the evidence for
 * everything else - an orphaned grandchild of a crashed host, a shell or
 * editor left in a managed worktree, an external tool running a provider
 * binary from the root.
 *
 * Fail closed: a probe that cannot run or cannot be parsed yields
 * `unprovable`, never `clear`. A process found using the root blocks.
 *
 * Which processes are relevant: this account's, on every platform. POSIX
 * requires the root to be mode 0700 and owned by the account (checked here),
 * so no other ordinary account can reach it. On Windows, what the census
 * cannot inspect never decides the result: another account's process, one
 * whose account cannot be read, and one of this account whose handles or
 * image cannot be read (see `WINDOWS_ROOT_CENSUS_SCRIPT`). A write by any of
 * them is caught by the source re-walk at copying, repairing and revalidation
 * (`assertSourceUnchanged`), which stops the run as `source-*` before the
 * switch; the root's private ACL keeps other ordinary accounts out.
 *
 * What a snapshot cannot see, on any platform: a process that holds NO handle
 * inside the root now but opens a path later (an editor that saves by absolute
 * path with no watch handle open; FSEvents/inotify watchers hold no descriptor
 * on the watched folder). Those are disclosed limitations, not proof.
 */

export type RootUser = {
  readonly pid: number;
  readonly name: string | null;
  /** `cwd`, `image`, or `handle`: how the process uses the root. */
  readonly evidence: string;
};

export type RootUserCensusResult =
  | { readonly kind: "clear" }
  | { readonly kind: "users"; readonly users: readonly RootUser[] }
  | { readonly kind: "unprovable"; readonly reason: string };

export interface RootUserCensus {
  /**
   * Reports every user, the coordinator included: only the census's own
   * helper processes are left out. Excluding the coordinator is the caller's
   * decision, made by verified incarnation (`excludeCoordinator`), never by
   * a bare pid or a process name.
   */
  census(input: {
    readonly root: string;
    readonly signal: AbortSignal;
  }): Promise<RootUserCensusResult>;
}

const CENSUS_TIMEOUT_MS = 120_000;

type StreamedCommand = {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly childPid: number | null;
};

/** Run `command` and feed each stdout line to `onLine`; bounded by a timeout. */
function streamLines(
  command: string,
  args: readonly string[],
  onLine: (line: string) => void,
  signal: AbortSignal,
  onSpawn: (pid: number) => void,
): Promise<StreamedCommand> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stderr = "";
    let failed = false;
    if (child.pid !== undefined) onSpawn(child.pid);
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, CENSUS_TIMEOUT_MS);
    const onAbort = (): void => {
      failed = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    createInterface({ input: child.stdout }).on("line", onLine);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: failed ? null : code,
        stderr,
        childPid: child.pid ?? null,
      });
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      Reflect.get(error, "code") === "ESRCH"
    );
  }
}

/**
 * POSIX: `ps` lists every process of this account; `lsof -F pn` lists their
 * open files (working directory, executable text, descriptors). Coverage is
 * checked, not assumed: every same-account process `ps` listed must appear in
 * the `lsof` output or have exited by the end, otherwise lsof could not
 * inspect it and the census is unprovable.
 */
export function posixRootUserCensus(input: {
  readonly uid: number;
}): RootUserCensus {
  return {
    census: async ({ root, signal }) => {
      const rootStats = await lstat(root);
      if ((rootStats.mode & 0o077) !== 0 || rootStats.uid !== input.uid) {
        return {
          kind: "unprovable",
          reason:
            "the data folder is accessible to other accounts, whose processes this census cannot inspect",
        };
      }
      // lsof names real paths (`/private/var/...` for `/var/...` on macOS).
      const realRoot = await realpath(root);
      const helperPids = new Set<number>();
      const accountPids = new Set<number>();
      const ps = await streamLines(
        "ps",
        ["-A", "-o", "pid=,uid="],
        (line) => {
          const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
          if (match !== null && Number(match[2]) === input.uid)
            accountPids.add(Number(match[1]));
        },
        signal,
        (pid) => helperPids.add(pid),
      );
      if (ps.exitCode !== 0 || accountPids.size === 0) {
        return {
          kind: "unprovable",
          reason: "the process list could not be read",
        };
      }
      const inspected = new Set<number>();
      const users = new Map<number, RootUser>();
      let current: number | null = null;
      let currentFd: string | null = null;
      let currentName: string | null = null;
      const lsof = await streamLines(
        "lsof",
        ["-n", "-P", "-w", "-u", String(input.uid), "-F", "pcfn"],
        (line) => {
          const tag = line.charAt(0);
          const value = line.slice(1);
          if (tag === "p") {
            current = Number(value);
            currentName = null;
            inspected.add(current);
          } else if (tag === "c") {
            currentName = value;
          } else if (tag === "f") {
            currentFd = value;
          } else if (
            tag === "n" &&
            current !== null &&
            !helperPids.has(current)
          ) {
            const path = value.replace(/ \((?:deleted|readlink: .*)\)$/u, "");
            const inside =
              path.startsWith("/") &&
              (pathInsideRoot(path, root, "posix") !== null ||
                pathInsideRoot(path, realRoot, "posix") !== null);
            const evidence =
              currentFd === "cwd"
                ? "cwd"
                : currentFd === "txt"
                  ? "image"
                  : "handle";
            // An open handle or working directory outranks the image: the
            // coordinator may run from the root, never hold anything in it.
            if (
              inside &&
              (!users.has(current) || users.get(current)?.evidence === "image")
            ) {
              users.set(current, { pid: current, name: currentName, evidence });
            }
          }
        },
        signal,
        (pid) => helperPids.add(pid),
      );
      if (
        lsof.exitCode === null ||
        (lsof.exitCode !== 0 && inspected.size === 0)
      ) {
        return { kind: "unprovable", reason: "lsof could not list open files" };
      }
      const uninspected = [...accountPids].filter(
        (pid) =>
          !helperPids.has(pid) && !inspected.has(pid) && processAlive(pid),
      );
      if (uninspected.length > 0) {
        return {
          kind: "unprovable",
          reason: `${uninspected.length} processes of this account could not be inspected`,
        };
      }
      if (signal.aborted)
        return { kind: "unprovable", reason: "the census was cancelled" };
      return users.size === 0
        ? { kind: "clear" }
        : { kind: "users", users: [...users.values()] };
    },
  };
}

// ---- Windows ------------------------------------------------------------------

const windowsCensusOutputSchema = z.strictObject({
  users: z.array(
    z.strictObject({
      pid: z.number().int(),
      name: z.string().nullable(),
      evidence: z.string(),
    }),
  ),
  /** Processes of this account that could not be fully inspected. */
  uninspectable: z.array(
    z.strictObject({
      pid: z.number().int(),
      name: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  /** Processes the OS attributes to another account. */
  foreign: z.array(
    z.strictObject({ pid: z.number().int(), name: z.string().nullable() }),
  ),
  /** Processes whose account could not be read. */
  unattributed: z.array(
    z.strictObject({ pid: z.number().int(), name: z.string().nullable() }),
  ),
  error: z.string().nullable(),
});
export type WindowsCensusOutput = z.infer<typeof windowsCensusOutputSchema>;

/**
 * The Windows census: one PowerShell process compiling a small C# helper
 * (`Add-Type`).
 *
 * It decides on the holders it finds among this account's processes; what
 * it cannot inspect is reported (`uninspectable`, `foreign`, `unattributed`)
 * but never decides the result. On real Windows, a non-admin account read
 * every other account's process, SYSTEM services included, as "account could
 * not be read" (718-8 P1), and a normal desktop session always holds some of
 * its own processes it cannot inspect (718-8 P4: ctfmon.exe with UIAccess and
 * DefenderSessionHelper.exe as a protected process refuse handle
 * duplication; taskhostw.exe holds a raw-disk handle with no path). A rule
 * that refused on either refused every migration. The source re-walk before
 * the switch and the root's private ACL (718-8 P2) cover them. The same runs
 * found this account's working-directory, open-file and image holders.
 *
 * Who a process runs as is read from the OS, never inferred from where it
 * runs or what its image is:
 * - the owner SID comes from the Remote Desktop Services process list
 *   (`WTSEnumerateProcessesExW`, level 1) or, failing that, the process token
 *   (`TokenUser`);
 * - this account's SID: inspected in full;
 * - the two readings disagree: `uninspectable` when either reading is this
 *   account, otherwise `unattributed`;
 * - the OS service and virtual accounts (S-1-5-18 SYSTEM, -19 LOCAL SERVICE,
 *   -20 NETWORK SERVICE, S-1-5-90-0-* Window Manager, S-1-5-96-0-* Font
 *   Driver Host): skipped, by authenticated principal;
 * - pid 0 (System Idle) and pid 4 (System, the kernel): OS special cases at
 *   fixed pids on every NT build;
 * - any other account: `foreign`;
 * - no owner at all: `unattributed`.
 *
 * For each process of this account, with its creation time taken at
 * enumeration:
 * - the image (`QueryFullProcessImageNameW`) inside the root is a user, even
 *   when some of its handles cannot be read; a failed query is uninspectable
 *   unless the process is proven gone;
 * - every handle of the kernel `File` type (`NtQuerySystemInformation`,
 *   `SystemExtendedHandleInformation`; the type index learned from a handle
 *   this helper holds) is duplicated and resolved: `GetFileType` (disk only;
 *   a pipe or character device is proven not a disk file) then
 *   `GetFinalPathNameByHandleW` (DOS name, then the NT device name compared
 *   with the root's own NT name). A working directory is such a folder handle
 *   (VM: that a cwd is always an open handle). A handle value that no longer
 *   names an object when duplicated (ERROR_INVALID_HANDLE) was closed between
 *   the snapshot and the duplication and is not open at that instant; every
 *   other failure is uninspectable;
 * - a process "proven gone" is one that cannot be opened because the pid no
 *   longer exists, or whose exit code or creation time shows it ended or the
 *   pid was reused since enumeration.
 *
 * Resource bounds: each handle query runs on a background thread joined for
 * 250 ms; a query that does not return marks its process uninspectable and
 * leaves its thread blocked, and more than 16 such threads abort the census
 * (`error`). Blocked threads die with this helper process, which the caller
 * kills after `CENSUS_TIMEOUT_MS` at the latest.
 *
 * The census excludes only this helper itself. Excluding the coordinator is
 * the engine's job, by verified incarnation.
 */
export const WINDOWS_ROOT_CENSUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public sealed class CensusProcess { public int Pid; public string Name; public long Created; public string Evidence; public string Unread; }
public static class TraycerRootCensus {
  [StructLayout(LayoutKind.Sequential)] struct HandleEntry { public IntPtr Object; public IntPtr Pid; public IntPtr Handle; public uint Access; public ushort Creator; public ushort TypeIndex; public uint Attributes; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct WtsProcessInfoEx { public int SessionId; public int ProcessId; public IntPtr ProcessName; public IntPtr UserSid; public int Threads; public int Handles; public int Pagefile; public int PeakPagefile; public int WorkingSet; public int PeakWorkingSet; public long UserTime; public long KernelTime; }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSEnumerateProcessesExW(IntPtr server, ref int level, int session, out IntPtr info, out int count);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSFreeMemoryExW(int type, IntPtr mem, int count);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr p, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder buf, uint len, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr p, uint flags, StringBuilder buf, ref uint len);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  const uint QUERY_LIMITED = 0x1000, DUP_HANDLE = 0x40, TOKEN_QUERY = 0x8, SAME_ACCESS = 0x2, STILL_ACTIVE = 259;
  const int ERROR_INVALID_HANDLE = 6, ERROR_INVALID_PARAMETER = 87;
  const uint FILE_TYPE_DISK = 1, FILE_TYPE_UNKNOWN = 0, VOLUME_NAME_NT = 2;
  static readonly IntPtr INVALID = new IntPtr(-1);

  static string SidString(IntPtr sid) {
    if (sid == IntPtr.Zero) return null;
    IntPtr s; if (!ConvertSidToStringSidW(sid, out s)) return null;
    try { return Marshal.PtrToStringUni(s); } finally { LocalFree(s); }
  }
  // Owner SIDs from the Remote Desktop Services process list, by pid.
  public static Dictionary<int, string> ListedOwners() {
    var owners = new Dictionary<int, string>();
    int level = 1; IntPtr info; int count;
    if (!WTSEnumerateProcessesExW(IntPtr.Zero, ref level, -2, out info, out count)) throw new Exception("the session process list could not be read (" + Marshal.GetLastWin32Error() + ")");
    try {
      int size = Marshal.SizeOf(typeof(WtsProcessInfoEx));
      for (int i = 0; i < count; i++) {
        var e = (WtsProcessInfoEx)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + (long)i * size), typeof(WtsProcessInfoEx));
        owners[e.ProcessId] = SidString(e.UserSid);
      }
    } finally { WTSFreeMemoryExW(1, info, count); }
    return owners;
  }
  public static string TokenOwner(int pid) {
    IntPtr p = OpenProcess(QUERY_LIMITED, false, pid); if (p == IntPtr.Zero) return null;
    try {
      IntPtr t; if (!OpenProcessToken(p, TOKEN_QUERY, out t)) return null;
      try {
        int len; GetTokenInformation(t, 1, IntPtr.Zero, 0, out len); if (len <= 0) return null;
        IntPtr buf = Marshal.AllocHGlobal(len);
        try { return GetTokenInformation(t, 1, buf, len, out len) ? SidString(Marshal.ReadIntPtr(buf)) : null; } finally { Marshal.FreeHGlobal(buf); }
      } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }
  // Creation time, or 0 when the process cannot be opened; -1 when the pid no longer exists.
  public static long CreationTime(int pid) {
    IntPtr p = OpenProcess(QUERY_LIMITED, false, pid);
    if (p == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER ? -1 : 0;
    try { long c, x, k, u; return GetProcessTimes(p, out c, out x, out k, out u) ? c : 0; } finally { CloseHandle(p); }
  }
  // Proven gone: the pid no longer exists, the process exited, or the pid was reused.
  public static bool Gone(CensusProcess proc) {
    IntPtr p = OpenProcess(QUERY_LIMITED, false, proc.Pid);
    if (p == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER;
    try {
      uint code; long c, x, k, u;
      if (GetExitCodeProcess(p, out code) && code != STILL_ACTIVE) return true;
      return GetProcessTimes(p, out c, out x, out k, out u) && proc.Created != 0 && c != proc.Created;
    } finally { CloseHandle(p); }
  }
  public static string Image(int pid) {
    IntPtr p = OpenProcess(QUERY_LIMITED, false, pid); if (p == IntPtr.Zero) return null;
    try { var b = new StringBuilder(32768); uint n = (uint)b.Capacity; return QueryFullProcessImageNameW(p, 0, b, ref n) ? b.ToString() : null; } finally { CloseHandle(p); }
  }
  // The root's own final DOS and NT names, from a handle on the folder.
  public static string[] RootNames(string root) {
    IntPtr h = CreateFileW(root, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == INVALID) throw new Exception("the data folder could not be opened (" + Marshal.GetLastWin32Error() + ")");
    try {
      string dos = FinalName(h, 0), nt = FinalName(h, VOLUME_NAME_NT);
      if (dos == null || nt == null) throw new Exception("the data folder's name could not be resolved");
      return new string[] { Strip(dos), nt };
    } finally { CloseHandle(h); }
  }
  static string FinalName(IntPtr h, uint flags) {
    var b = new StringBuilder(32768); uint n = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, flags);
    return n > 0 && n < b.Capacity ? b.ToString() : null;
  }
  static string Strip(string p) {
    if (p.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\" + p.Substring(7);
    if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p.Substring(4);
    return p;
  }
  public static bool Under(string path, string root) {
    if (path == null) return false;
    string r = root.TrimEnd('\\');
    return path.Equals(r, StringComparison.OrdinalIgnoreCase) || path.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase);
  }
  static HandleEntry Entry(IntPtr first, long i, int entrySize) {
    return (HandleEntry)Marshal.PtrToStructure(new IntPtr(first.ToInt64() + i * entrySize), typeof(HandleEntry));
  }
  // Marks each process with 'handle' evidence or an 'Unread' reason.
  public static void InspectHandles(Dictionary<int, CensusProcess> procs, string[] rootNames) {
    string probePath = System.IO.Path.GetTempFileName();
    var probe = new System.IO.FileStream(probePath, System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.ReadWrite, 1, System.IO.FileOptions.DeleteOnClose);
    int size = 1 << 20; IntPtr buf = IntPtr.Zero; int status; int ret;
    try {
      for (;;) { buf = Marshal.AllocHGlobal(size); status = NtQuerySystemInformation(64, buf, size, out ret); if (status != unchecked((int)0xC0000004)) break; Marshal.FreeHGlobal(buf); buf = IntPtr.Zero; size = Math.Max(size * 2, ret + 65536); if (size > (1 << 30)) throw new Exception("handle table too large"); }
      if (status != 0) throw new Exception("NtQuerySystemInformation failed " + status);
      long count = Marshal.ReadIntPtr(buf).ToInt64();
      int entrySize = Marshal.SizeOf(typeof(HandleEntry));
      IntPtr first = IntPtr.Add(buf, IntPtr.Size * 2);
      int self = System.Diagnostics.Process.GetCurrentProcess().Id; IntPtr own = probe.SafeFileHandle.DangerousGetHandle(); int fileType = -1;
      for (long i = 0; i < count; i++) { var e = Entry(first, i, entrySize); if (e.Pid.ToInt64() == self && e.Handle == own) { fileType = e.TypeIndex; break; } }
      if (fileType < 0) throw new Exception("the file handle type could not be identified");
      var opened = new Dictionary<int, IntPtr>(); int hung = 0;
      try {
        for (long i = 0; i < count; i++) {
          var e = Entry(first, i, entrySize);
          int pid = (int)e.Pid.ToInt64(); CensusProcess proc;
          if (e.TypeIndex != fileType || !procs.TryGetValue(pid, out proc) || proc.Unread != null || proc.Evidence == "handle") continue;
          IntPtr source;
          if (!opened.TryGetValue(pid, out source)) {
            source = OpenProcess(DUP_HANDLE, false, pid); opened[pid] = source;
            if (source == IntPtr.Zero) { proc.Unread = "its handles could not be opened for inspection"; continue; }
          }
          if (source == IntPtr.Zero) continue;
          IntPtr dup;
          if (!DuplicateHandle(source, e.Handle, GetCurrentProcess(), out dup, 0, false, SAME_ACCESS)) {
            if (Marshal.GetLastWin32Error() != ERROR_INVALID_HANDLE) proc.Unread = "a handle could not be duplicated for inspection";
            continue;
          }
          string found = null; string failure = null; IntPtr target = dup;
          var worker = new System.Threading.Thread(() => {
            uint type = GetFileType(target);
            if (type == FILE_TYPE_UNKNOWN && Marshal.GetLastWin32Error() != 0) { failure = "a handle's type could not be read"; return; }
            if (type != FILE_TYPE_DISK) return;
            string dos = FinalName(target, 0);
            if (dos != null) { found = Strip(dos); return; }
            string nt = FinalName(target, VOLUME_NAME_NT);
            if (nt != null) { found = Under(nt, rootNames[1]) ? rootNames[0] : nt; return; }
            failure = "a handle's path could not be resolved";
          });
          worker.IsBackground = true; worker.Start();
          if (!worker.Join(250)) {
            // Left open: the blocked query still uses it; it dies with this process.
            proc.Unread = "a handle query did not answer";
            if (++hung > 16) throw new Exception("too many handles did not answer");
            continue;
          }
          CloseHandle(dup);
          if (failure != null) proc.Unread = failure;
          else if (Under(found, rootNames[0])) proc.Evidence = "handle";
        }
      } finally { foreach (var h in opened.Values) if (h != IntPtr.Zero) CloseHandle(h); }
    } finally { if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf); probe.Dispose(); }
  }
  public static bool ServiceAccount(string sid) {
    return sid == "S-1-5-18" || sid == "S-1-5-19" || sid == "S-1-5-20" || sid.StartsWith("S-1-5-90-0-", StringComparison.Ordinal) || sid.StartsWith("S-1-5-96-0-", StringComparison.Ordinal);
  }
}
'@
$out = @{ users = @(); uninspectable = @(); foreign = @(); unattributed = @(); error = $null }
try {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rootNames = [TraycerRootCensus]::RootNames($env:TRAYCER_CENSUS_ROOT)
  $owners = [TraycerRootCensus]::ListedOwners()
  $mine = New-Object 'System.Collections.Generic.Dictionary[int,CensusProcess]'
  foreach ($proc in [System.Diagnostics.Process]::GetProcesses()) {
    $id = $proc.Id
    if ($id -eq $PID -or $id -eq 0 -or $id -eq 4) { continue }
    $listed = $null; if ($owners.ContainsKey($id)) { $listed = $owners[$id] }
    $token = [TraycerRootCensus]::TokenOwner($id)
    $created = [TraycerRootCensus]::CreationTime($id)
    if ($created -eq -1) { continue }
    $p = New-Object CensusProcess; $p.Pid = $id; $p.Name = $proc.ProcessName; $p.Created = $created
    $owner = $listed; if ($null -eq $owner) { $owner = $token }
    if ($null -eq $owner) { $out.unattributed += @{ pid = $id; name = $p.Name }; continue }
    elseif ($null -ne $listed -and $null -ne $token -and $listed -ne $token) {
      if ($listed -ne $me -and $token -ne $me) { $out.unattributed += @{ pid = $id; name = $p.Name }; continue }
      $p.Unread = 'its account could not be established consistently'
    }
    elseif ($owner -eq $me) {
      $image = [TraycerRootCensus]::Image($id)
      if ($null -eq $image) { $p.Unread = 'its executable could not be read' }
      elseif ([TraycerRootCensus]::Under($image, $rootNames[0]) -or [TraycerRootCensus]::Under($image, $env:TRAYCER_CENSUS_ROOT)) { $p.Evidence = 'image' }
    }
    elseif ([TraycerRootCensus]::ServiceAccount($owner)) { continue }
    else { if (-not [TraycerRootCensus]::Gone($p)) { $out.foreign += @{ pid = $id; name = $p.Name } }; continue }
    $mine[$id] = $p
  }
  [TraycerRootCensus]::InspectHandles($mine, $rootNames)
  foreach ($p in $mine.Values) {
    if ($null -eq $p.Evidence -and $null -eq $p.Unread) { continue }
    if ([TraycerRootCensus]::Gone($p)) { continue }
    if ($null -ne $p.Evidence) { $out.users += @{ pid = $p.Pid; name = $p.Name; evidence = $p.Evidence } }
    else { $out.uninspectable += @{ pid = $p.Pid; name = $p.Name; reason = $p.Unread } }
  }
} catch { $out.error = $_.Exception.Message }
[Console]::Out.Write((ConvertTo-Json $out -Depth 4 -Compress))
`;

/**
 * Decides the census result from the helper's JSON: `unprovable` when the
 * helper did not run cleanly; otherwise this account's users. `uninspectable`,
 * `foreign` and `unattributed` processes never decide it. Exported for tests.
 */
export function interpretWindowsCensusOutput(
  stdout: string,
  exitCode: number | null,
): RootUserCensusResult {
  if (exitCode !== 0)
    return { kind: "unprovable", reason: "the process census could not run" };
  let parsed: WindowsCensusOutput;
  try {
    const raw: unknown = JSON.parse(stdout);
    // ConvertTo-Json renders a one-element array as a bare object.
    const normalized =
      typeof raw === "object" && raw !== null
        ? {
            ...raw,
            users: arrayOf(Reflect.get(raw, "users")),
            uninspectable: arrayOf(Reflect.get(raw, "uninspectable")),
            foreign: arrayOf(Reflect.get(raw, "foreign")),
            unattributed: arrayOf(Reflect.get(raw, "unattributed")),
          }
        : raw;
    parsed = windowsCensusOutputSchema.parse(normalized);
  } catch {
    return {
      kind: "unprovable",
      reason: "the process census returned unreadable output",
    };
  }
  if (parsed.error !== null)
    return { kind: "unprovable", reason: "the process census failed" };
  const users = new Map<number, RootUser>();
  for (const user of parsed.users)
    if (!users.has(user.pid)) users.set(user.pid, user);
  return users.size === 0
    ? { kind: "clear" }
    : { kind: "users", users: [...users.values()] };
}

function arrayOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The census script is far longer than a Windows command line may be
 * (CreateProcess caps it at 32,767 characters; the script alone is over that
 * once UTF-16LE Base64-encoded), so only this short bootstrap travels as
 * `-EncodedCommand` and the script arrives on stdin. Nothing is written to
 * disk. Exported so a test pins the bound.
 */
export const WINDOWS_CENSUS_BOOTSTRAP =
  "$ErrorActionPreference='Stop';[Console]::InputEncoding=[System.Text.Encoding]::UTF8;" +
  "$s=[Console]::In.ReadToEnd();& ([scriptblock]::Create($s))";

export function windowsCensusArguments(): readonly string[] {
  const encoded = Buffer.from(WINDOWS_CENSUS_BOOTSTRAP, "utf16le").toString(
    "base64",
  );
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

export function windowsRootUserCensus(): RootUserCensus {
  return {
    census: async ({ root, signal }) => {
      let stdout = "";
      let overflow = false;
      const result = await new Promise<number | null>((resolve) => {
        const child = spawn("powershell.exe", [...windowsCensusArguments()], {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          shell: false,
          env: { ...process.env, TRAYCER_CENSUS_ROOT: root },
        });
        let failed = false;
        const timer = setTimeout(() => {
          failed = true;
          child.kill();
        }, CENSUS_TIMEOUT_MS);
        const onAbort = (): void => {
          failed = true;
          child.kill();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length + chunk.length > 8 * 1024 * 1024) {
            overflow = true;
            failed = true;
            child.kill();
            return;
          }
          stdout += chunk.toString("utf8");
        });
        child.on("error", () => {
          failed = true;
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(failed ? null : code);
        });
        // A helper that dies before reading its stdin fails the census, never the caller.
        child.stdin.on("error", () => {
          failed = true;
        });
        child.stdin.end(WINDOWS_ROOT_CENSUS_SCRIPT, "utf8");
      });
      if (overflow)
        return {
          kind: "unprovable",
          reason: "the process census returned too much output",
        };
      return interpretWindowsCensusOutput(stdout, result);
    },
  };
}

/**
 * Drop the coordinator from a census result, but only when the reported pid
 * IS the coordinator's recorded incarnation (same pid and start identity,
 * verified now) AND its only use of the root is its executable image (the
 * CLI is installed there). A working directory or an open handle inside the
 * source is a caller-precondition violation (the coordinator must never
 * write the source) and stays a user. Any other user stays.
 */
export async function excludeCoordinator(
  result: RootUserCensusResult,
  coordinator: {
    readonly pid: number;
    readonly startIdentity: ProcessStartIdentity | null;
  },
  probe: ProcessIncarnationProbe,
): Promise<RootUserCensusResult> {
  if (result.kind !== "users") return result;
  const remaining: RootUser[] = [];
  for (const user of result.users) {
    const isCoordinator =
      user.pid === coordinator.pid &&
      user.evidence === "image" &&
      coordinator.startIdentity !== null &&
      (await probe.verdict(user.pid, coordinator.startIdentity)) ===
        "alive-same";
    if (!isCoordinator) remaining.push(user);
  }
  return remaining.length === 0
    ? { kind: "clear" }
    : { kind: "users", users: remaining };
}
