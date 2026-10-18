import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import {
  dataRootPathsOverlap,
  validateDataRootSelection,
  type DataRootPlatform,
} from "./data-root";

/**
 * Probing and private creation of a NEW data root, and protection of the
 * fixed bootstrap directory. Shared by every setup path that may select a
 * root (data init/migrate, the installer) and by the writers of bootstrap
 * records; nothing here selects a root or writes a location record.
 *
 * Windows v1 contract (design: "Root discovery contract"): the destination is
 * a dedicated, empty directory on a fixed local NTFS volume, reached without
 * junctions/symlinks/mount points/SUBST aliases, that does not overlap any
 * protected root. Its DACL is PROTECTED (no inherited grants) and allows only
 * the current account, SYSTEM and Administrators, and this is applied AND read
 * back - including on freshly created children - before the caller writes
 * anything into it. Any step that cannot be established refuses; nothing
 * outside the destination is created or re-permissioned.
 */

export type DataRootTargetRefusalCode =
  | "invalid-path"
  | "overlaps-protected-root"
  | "parent-missing"
  | "unsupported-reparse-point"
  | "not-a-directory"
  | "populated"
  | "unsupported-entry"
  | "unsupported-volume"
  | "acl-not-established";

export type DataRootTargetResult =
  | { readonly ok: true; readonly root: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly code: DataRootTargetRefusalCode;
      readonly reason: string;
    };

/** What a Windows volume/ancestor probe reports for one path. */
export interface WindowsVolumeProbe {
  /** `System.IO.DriveType` name: `Fixed`, `Network`, `Removable`, `CDRom`, `Ram`, `NoRootDirectory`, `Unknown`. */
  readonly driveType: string;
  /** `DriveFormat` (`NTFS`, `FAT32`, `exFAT`, `ReFS`, …), or null when the drive is not ready. */
  readonly fileSystem: string | null;
  /** Whether any EXISTING component of the path carries FILE_ATTRIBUTE_REPARSE_POINT. */
  readonly reparseInPath: boolean;
}

export interface WindowsAclRule {
  readonly sid: string;
  readonly allow: boolean;
  readonly inherited: boolean;
}

/** One path's DACL as read back from disk. */
export interface WindowsAclReport {
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly protectedFromInheritance: boolean;
  readonly rules: readonly WindowsAclRule[];
  /** Read-backs of a child directory and file created inside it (apply only). */
  readonly childProbes: readonly (readonly WindowsAclRule[])[];
}

/** The Windows-only facts, behind an interface so tests never spawn PowerShell. */
export interface WindowsDataRootCommands {
  probeVolume(path: string): Promise<WindowsVolumeProbe>;
  /** Replaces the DACL with the private one, then reads it and two fresh children back. */
  applyPrivateAcl(directory: string): Promise<WindowsAclReport>;
  readAcl(path: string): Promise<WindowsAclReport>;
  /**
   * For each DIRECT child of `directory`: a regular file has every explicit
   * ACE removed and inheritance re-enabled (so it carries exactly the
   * protected parent's grants), then is read back. Anything else - a folder or
   * any reparse point - is reported, never followed or modified.
   */
  securePrivateChildren(
    directory: string,
  ): Promise<readonly WindowsChildAclReport[]>;
}

export type WindowsChildAclReport =
  | { readonly kind: "file"; readonly report: WindowsAclReport }
  | { readonly kind: "directory" }
  | { readonly kind: "reparse" }
  /** Listed, then proven gone (removed by its owner) before it was secured. */
  | { readonly kind: "vanished"; readonly name: string };

/**
 * Bootstrap entries that live processes create and remove on their own
 * schedule, outside any lock the securing caller can hold: data-migration
 * admission entries (removed by their process's release or exit hook), the
 * admission mutex and coordinator lock files, atomic-write temps
 * (`<name>.<uuid>.tmp`) and lock-takeover graves (`<name>.dead-<uuid>`).
 * One that disappears between being listed and being secured had nothing
 * left to protect. Every other entry - `location*.json`, `migration*.json` -
 * is a persistent record: its disappearance mid-run refuses.
 */
const TRANSIENT_BOOTSTRAP_ENTRY =
  /^(?:admission-[0-9a-f-]{36}\.json|admission\.lock|migration-coordinator\.lock|.+\.[0-9a-f-]{32,36}\.tmp|.+\.dead-[0-9a-f-]{36})$/u;

export function isTransientBootstrapEntryName(name: string): boolean {
  return TRANSIENT_BOOTSTRAP_ENTRY.test(name);
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

/**
 * Prepare a fresh private data root at `requested`. `protectedRoots` are the
 * roots it must neither equal nor contain nor sit inside (the current data
 * root and the bootstrap directory at least). `platform` selects path rules;
 * production callers pass `"win32"` (Windows is the only v1 target).
 */
export async function preparePrivateDataRoot(input: {
  readonly requested: string;
  readonly protectedRoots: readonly string[];
  readonly platform: DataRootPlatform;
  readonly commands: WindowsDataRootCommands;
}): Promise<DataRootTargetResult> {
  const check = validateDataRootSelection(input.requested, input.platform);
  if (!check.ok) return refuse("invalid-path", check.reason);
  const target = check.root;
  for (const protectedRoot of input.protectedRoots) {
    if (dataRootPathsOverlap(target, protectedRoot, input.platform)) {
      return refuse(
        "overlaps-protected-root",
        "the folder overlaps an existing Traycer data or bootstrap folder",
      );
    }
  }
  const parent = dirname(target);
  const parentStat = await lstatOrNull(parent);
  if (parentStat === null) {
    return refuse("parent-missing", "the parent folder does not exist");
  }
  if (!parentStat.isDirectory() && !parentStat.isSymbolicLink()) {
    return refuse("not-a-directory", "the parent path is not a folder");
  }
  // Every EXISTING component must be a plain directory reached by its own
  // name: a link/junction/mount anywhere puts the root somewhere other than
  // where the path says, which breaks the overlap and volume checks below.
  const existingChain = await existingAncestorChain(target);
  for (const component of existingChain) {
    if (component.isSymbolicLink) {
      return refuse(
        "unsupported-reparse-point",
        "the path goes through a link or junction",
      );
    }
  }
  const realParent = await realpath(parent);
  if (
    comparable(realParent, input.platform) !==
    comparable(parent, input.platform)
  ) {
    return refuse(
      "unsupported-reparse-point",
      "the parent folder is reached through an alias (link, junction, mount point or substituted drive)",
    );
  }
  for (const protectedRoot of input.protectedRoots) {
    const realProtected = await realpathAllowingMissingTail(protectedRoot);
    if (
      dataRootPathsOverlap(
        join(realParent, basename(target)),
        realProtected,
        input.platform,
      )
    ) {
      return refuse(
        "overlaps-protected-root",
        "the folder's real location overlaps an existing Traycer data or bootstrap folder",
      );
    }
  }
  let volume: WindowsVolumeProbe;
  try {
    volume = await input.commands.probeVolume(parent);
  } catch {
    return refuse("unsupported-volume", "the drive could not be identified");
  }
  const volumeRefusal = evaluateWindowsVolume(volume);
  if (volumeRefusal !== null) return volumeRefusal;

  const targetStat = await lstatOrNull(target);
  let created = false;
  if (targetStat === null) {
    try {
      await mkdir(target);
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  if (!created) {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      return refuse(
        "unsupported-reparse-point",
        "the folder is a link or junction",
      );
    }
    if (!existing.isDirectory()) {
      return refuse("not-a-directory", "the path exists and is not a folder");
    }
    if ((await readdir(target)).length > 0) {
      return refuse(
        "populated",
        "the folder is not empty; choose a new or empty folder dedicated to Traycer",
      );
    }
  }
  let aclRefusal: DataRootTargetResult | null;
  try {
    aclRefusal = evaluateWindowsPrivateAcl(
      await input.commands.applyPrivateAcl(target),
      true,
    );
  } catch {
    aclRefusal = refuse(
      "acl-not-established",
      "the folder's permissions could not be set and verified",
    );
  }
  if (aclRefusal !== null) {
    // Only a folder this call created is removed; it is still empty.
    if (created) await rmdir(target).catch(() => undefined);
    return aclRefusal;
  }
  return { ok: true, root: target, created };
}

/**
 * Create (or confirm) the fixed `<home>/.traycer-bootstrap` directory as an
 * owner-private directory, INCLUDING the records already in it: the folder
 * holds the authoritative root selection, and on Windows a file's own DACL
 * still grants access through a private parent (traversal bypass), so
 * protecting the folder alone is not enough.
 *
 * The folder may hold records but only as DIRECT regular files; a link,
 * junction, other reparse point or sub-folder refuses before anything is
 * modified, and nothing is followed or changed recursively. Windows applies
 * and verifies the private DACL on the folder, then strips every explicit ACE
 * from each record so it inherits only the folder's grants, and verifies
 * each. POSIX requires owner `uid`, folder mode `0700` and record mode
 * `0600`.
 *
 * Live processes add and remove transient entries here concurrently
 * (admission entries, lock files, temps; {@link isTransientBootstrapEntryName}).
 * A transient entry proven gone after it was listed is skipped - nothing is
 * left to protect, and a later one inherits the protected folder's grants
 * (Windows) or is created `0600` (POSIX). A persistent record that disappears
 * mid-run still refuses.
 */
export async function ensurePrivateBootstrapDir(input: {
  readonly bootstrapDir: string;
  readonly platform: DataRootPlatform;
  readonly commands: WindowsDataRootCommands;
}): Promise<DataRootTargetResult> {
  const dir = input.bootstrapDir;
  let created = false;
  try {
    await mkdir(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return refuse("parent-missing", "the user profile folder does not exist");
    }
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const stats = await lstat(dir);
  if (stats.isSymbolicLink()) {
    return refuse(
      "unsupported-reparse-point",
      "the bootstrap folder is a link or junction",
    );
  }
  if (!stats.isDirectory()) {
    return refuse("not-a-directory", "the bootstrap path is not a folder");
  }
  const records: Stats[] = [];
  for (const name of await readdir(dir)) {
    const child = await lstatOrNull(join(dir, name));
    if (child === null) {
      if (isTransientBootstrapEntryName(name)) continue;
      return refuse(
        "unsupported-entry",
        "a bootstrap record disappeared while it was being secured",
      );
    }
    if (child.isSymbolicLink()) {
      return refuse(
        "unsupported-reparse-point",
        "the bootstrap folder contains a link or junction",
      );
    }
    if (!child.isFile()) {
      return refuse(
        "unsupported-entry",
        "the bootstrap folder contains an entry that is not a plain file",
      );
    }
    records.push(child);
  }
  if (input.platform === "win32") {
    return secureWindowsBootstrapDir(dir, created, input.commands);
  }
  const uid = process.getuid?.();
  if (
    uid !== undefined &&
    (stats.uid !== uid || records.some((r) => r.uid !== uid))
  ) {
    return refuse(
      "acl-not-established",
      "the bootstrap folder or a record in it is owned by another user",
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    await chmod(dir, 0o700);
    if (((await lstat(dir)).mode & 0o077) !== 0) {
      return refuse(
        "acl-not-established",
        "the bootstrap folder could not be made private",
      );
    }
  }
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const transient = isTransientBootstrapEntryName(name);
    const child = await lstatOrNull(path);
    if (child === null) {
      if (transient) continue;
      return refuse(
        "unsupported-entry",
        "a bootstrap record disappeared while it was being secured",
      );
    }
    if (!child.isFile()) {
      return refuse(
        "unsupported-entry",
        "the bootstrap folder changed while it was being secured",
      );
    }
    if ((child.mode & 0o077) === 0) continue;
    try {
      await chmod(path, 0o600);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (transient) continue;
      return refuse(
        "unsupported-entry",
        "a bootstrap record disappeared while it was being secured",
      );
    }
    const secured = await lstatOrNull(path);
    if (secured === null && transient) continue;
    if (secured === null || (secured.mode & 0o077) !== 0) {
      return refuse(
        "acl-not-established",
        "a bootstrap record could not be made private",
      );
    }
  }
  return { ok: true, root: dir, created };
}

async function secureWindowsBootstrapDir(
  dir: string,
  created: boolean,
  commands: WindowsDataRootCommands,
): Promise<DataRootTargetResult> {
  let report: WindowsAclReport;
  let children: readonly WindowsChildAclReport[];
  try {
    report = await commands.applyPrivateAcl(dir);
    const folderRefusal = evaluateWindowsPrivateAcl(report, true);
    if (folderRefusal !== null) return folderRefusal;
    children = await commands.securePrivateChildren(dir);
  } catch {
    return refuse(
      "acl-not-established",
      "the bootstrap folder's permissions could not be set and verified",
    );
  }
  for (const child of children) {
    if (child.kind === "vanished") {
      if (isTransientBootstrapEntryName(child.name)) continue;
      return refuse(
        "unsupported-entry",
        "a bootstrap record disappeared while it was being secured",
      );
    }
    if (child.kind === "reparse") {
      return refuse(
        "unsupported-reparse-point",
        "the bootstrap folder contains a reparse point",
      );
    }
    if (child.kind === "directory") {
      return refuse(
        "unsupported-entry",
        "the bootstrap folder contains a sub-folder",
      );
    }
    const refusal = evaluateWindowsPrivateAcl(child.report, false);
    if (refusal !== null) return refusal;
    if (
      child.report.protectedFromInheritance ||
      child.report.rules.some((rule) => !rule.inherited)
    ) {
      return refuse(
        "acl-not-established",
        "a bootstrap record still carries its own permissions",
      );
    }
  }
  return { ok: true, root: dir, created };
}

/** Fixed local NTFS only; anything unidentifiable refuses. */
export function evaluateWindowsVolume(
  probe: WindowsVolumeProbe,
): DataRootTargetResult | null {
  if (probe.reparseInPath) {
    return refuse(
      "unsupported-reparse-point",
      "the path goes through a junction, mount point or other reparse point",
    );
  }
  if (probe.driveType !== "Fixed") {
    return refuse(
      "unsupported-volume",
      probe.driveType === "Network"
        ? "network drives are not supported; choose a folder on a local fixed drive"
        : `the drive type '${probe.driveType}' is not supported; choose a folder on a local fixed drive`,
    );
  }
  if (probe.fileSystem === null) {
    return refuse(
      "unsupported-volume",
      "the drive's file system could not be identified",
    );
  }
  if (probe.fileSystem.toUpperCase() !== "NTFS") {
    return refuse(
      "unsupported-volume",
      `the drive is formatted ${probe.fileSystem}; Traycer needs an NTFS drive`,
    );
  }
  return null;
}

/**
 * Whether a DACL read-back keeps the folder private: owner is the current
 * account or Administrators; every allow rule names only the current account,
 * SYSTEM or Administrators; and, for a root, inheritance is protected, nothing
 * is inherited, the current account is granted, and freshly created children
 * inherit only those grants.
 */
export function evaluateWindowsPrivateAcl(
  report: WindowsAclReport,
  isRoot: boolean,
): DataRootTargetResult | null {
  const allowed = new Set([
    report.currentUserSid.toUpperCase(),
    SYSTEM_SID,
    ADMINISTRATORS_SID,
  ]);
  const owner = report.ownerSid.toUpperCase();
  if (
    owner !== report.currentUserSid.toUpperCase() &&
    owner !== ADMINISTRATORS_SID
  ) {
    return refuse(
      "acl-not-established",
      "the folder is owned by another account",
    );
  }
  const foreign = (rules: readonly WindowsAclRule[]): boolean =>
    rules.some((rule) => rule.allow && !allowed.has(rule.sid.toUpperCase()));
  if (foreign(report.rules)) {
    return refuse(
      "acl-not-established",
      "the folder grants access to another account",
    );
  }
  if (!isRoot) return null;
  if (
    !report.protectedFromInheritance ||
    report.rules.some((rule) => rule.inherited)
  ) {
    return refuse(
      "acl-not-established",
      "the folder still inherits permissions from its parent",
    );
  }
  if (
    !report.rules.some(
      (rule) =>
        rule.allow &&
        rule.sid.toUpperCase() === report.currentUserSid.toUpperCase(),
    )
  ) {
    return refuse(
      "acl-not-established",
      "the folder does not grant the current account access",
    );
  }
  if (report.childProbes.length === 0 || report.childProbes.some(foreign)) {
    return refuse(
      "acl-not-established",
      "new files in the folder would not be private to the current account",
    );
  }
  return null;
}

// ---------------------------------------------------------------- PowerShell

const POWERSHELL_TIMEOUT_MS = 30_000;

// Paths travel in environment variables (UTF-16 end to end on Windows), never
// in script text, so no quoting can be wrong; output is forced to UTF-8.
const PROLOGUE =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
  "function Rules($a){@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');inherited=$_.IsInherited}})};";

const PROBE_VOLUME_SCRIPT =
  PROLOGUE +
  "$full=[System.IO.Path]::GetFullPath($env:TRAYCER_DATA_ROOT_PATH);" +
  "$d=New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($full));" +
  "$r=$false;$c=New-Object System.IO.DirectoryInfo($full);" +
  "while($c -ne $null){if($c.Exists -and ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint)){$r=$true};$c=$c.Parent};" +
  "$fs=$null;if($d.IsReady){$fs=$d.DriveFormat};" +
  "@{driveType=[string]$d.DriveType;fileSystem=$fs;reparseInPath=$r}|ConvertTo-Json -Compress -Depth 4";

const READ_ACL_BODY =
  "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
  "$v=(Get-Item -LiteralPath $p -Force).GetAccessControl('Access,Owner');" +
  "$o=@{currentUserSid=$me;ownerSid=$v.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protectedFromInheritance=$v.AreAccessRulesProtected;rules=@(Rules $v);childProbes=@($probes)};" +
  "$o|ConvertTo-Json -Compress -Depth 6";

// Direct children only, never recursive and never through a reparse point:
// `Get-ChildItem` without `-Recurse` lists only the folder's own entries, and
// a reparse entry (link, junction, cloud placeholder) or sub-folder is
// reported without being touched. A child whose securing fails and that no
// longer exists is reported `vanished` by name (the caller decides whether
// that name may disappear); any other failure still fails the whole run.
const SECURE_PRIVATE_CHILDREN_SCRIPT =
  PROLOGUE +
  "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$out=@();" +
  "foreach($c in @(Get-ChildItem -LiteralPath $env:TRAYCER_DATA_ROOT_PATH -Force)){" +
  "try{" +
  "if($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint){$out+=@{kind='reparse'};continue};" +
  "if($c.PSIsContainer){$out+=@{kind='directory'};continue};" +
  "$a=$c.GetAccessControl('Access');$a.SetAccessRuleProtection($false,$false);" +
  "foreach($x in @($a.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))){[void]$a.RemoveAccessRuleSpecific($x)};" +
  "$c.SetAccessControl($a);" +
  "$v=(Get-Item -LiteralPath $c.FullName -Force).GetAccessControl('Access,Owner');" +
  "$out+=@{kind='file';report=@{currentUserSid=$me;ownerSid=$v.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protectedFromInheritance=$v.AreAccessRulesProtected;rules=@(Rules $v);childProbes=@()}}" +
  "}catch{if(Test-Path -LiteralPath $c.FullName){throw};$out+=@{kind='vanished';name=$c.Name}}};" +
  "ConvertTo-Json -InputObject @($out) -Compress -Depth 8";

const READ_ACL_SCRIPT =
  PROLOGUE + "$p=$env:TRAYCER_DATA_ROOT_PATH;$probes=@();" + READ_ACL_BODY;

const APPLY_PRIVATE_ACL_SCRIPT =
  PROLOGUE +
  "$p=$env:TRAYCER_DATA_ROOT_PATH;$i=Get-Item -LiteralPath $p -Force;" +
  "if($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint){throw 'reparse point'};" +
  "$a=$i.GetAccessControl('Access');$a.SetAccessRuleProtection($true,$false);" +
  "foreach($x in @($a.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))){[void]$a.RemoveAccessRuleSpecific($x)};" +
  "$inh=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';" +
  "foreach($s in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'),(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'))){" +
  "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl',$inh,'None','Allow')))};" +
  "$i.SetAccessControl($a);" +
  "$n='.traycer-acl-probe-'+[guid]::NewGuid().ToString('N');" +
  "$cd=[System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($p,$n));" +
  "$fp=[System.IO.Path]::Combine($p,$n+'.tmp');[System.IO.File]::Create($fp).Dispose();$cf=New-Object System.IO.FileInfo($fp);" +
  "$probes=@(@(Rules $cd.GetAccessControl('Access')),@(Rules $cf.GetAccessControl('Access')));" +
  "$cd.Delete();$cf.Delete();" +
  READ_ACL_BODY;

/** Runs Windows PowerShell 5.1 (always present, and its .NET exposes the ACL instance methods). */
export type PowerShellRunner = (
  script: string,
  path: string,
) => Promise<string>;

export const runWindowsPowerShell: PowerShellRunner = (script, path) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, TRAYCER_DATA_ROOT_PATH: path },
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("Windows permission probe failed"));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });

export function createWindowsDataRootCommands(
  run: PowerShellRunner,
): WindowsDataRootCommands {
  return {
    probeVolume: async (path) =>
      parseWindowsVolumeProbe(await run(PROBE_VOLUME_SCRIPT, path)),
    applyPrivateAcl: async (directory) =>
      parseWindowsAclReport(await run(APPLY_PRIVATE_ACL_SCRIPT, directory)),
    readAcl: async (path) =>
      parseWindowsAclReport(await run(READ_ACL_SCRIPT, path)),
    securePrivateChildren: async (directory) =>
      parseWindowsChildAclReports(
        await run(SECURE_PRIVATE_CHILDREN_SCRIPT, directory),
      ),
  };
}

export function parseWindowsVolumeProbe(stdout: string): WindowsVolumeProbe {
  const raw: unknown = JSON.parse(stdout);
  if (!isRecord(raw) || typeof raw.driveType !== "string") {
    throw new Error("unrecognized volume probe output");
  }
  return {
    driveType: raw.driveType,
    fileSystem: typeof raw.fileSystem === "string" ? raw.fileSystem : null,
    reparseInPath: raw.reparseInPath === true,
  };
}

export function parseWindowsChildAclReports(
  stdout: string,
): WindowsChildAclReport[] {
  const trimmed = stdout.trim();
  // An empty folder serializes as nothing at all on some PowerShell builds.
  if (trimmed.length === 0) return [];
  return asArray(JSON.parse(trimmed)).map((entry): WindowsChildAclReport => {
    if (!isRecord(entry)) throw new Error("unrecognized child ACL entry");
    if (entry.kind === "reparse") return { kind: "reparse" };
    if (entry.kind === "directory") return { kind: "directory" };
    if (entry.kind === "vanished") {
      if (typeof entry.name !== "string")
        throw new Error("unrecognized child ACL entry");
      return { kind: "vanished", name: entry.name };
    }
    if (entry.kind !== "file") throw new Error("unrecognized child ACL entry");
    return { kind: "file", report: aclReportFrom(entry.report) };
  });
}

export function parseWindowsAclReport(stdout: string): WindowsAclReport {
  return aclReportFrom(JSON.parse(stdout));
}

function aclReportFrom(raw: unknown): WindowsAclReport {
  if (
    !isRecord(raw) ||
    typeof raw.currentUserSid !== "string" ||
    typeof raw.ownerSid !== "string" ||
    typeof raw.protectedFromInheritance !== "boolean"
  ) {
    throw new Error("unrecognized ACL probe output");
  }
  return {
    currentUserSid: raw.currentUserSid,
    ownerSid: raw.ownerSid,
    protectedFromInheritance: raw.protectedFromInheritance,
    rules: parseRules(raw.rules),
    // PowerShell 5.1 collapses a one-element array to its element and an
    // empty one to null, so both shapes are normalized here.
    childProbes: asArray(raw.childProbes).map((probe) => parseRules(probe)),
  };
}

function parseRules(value: unknown): WindowsAclRule[] {
  return asArray(value).map((rule) => {
    if (
      !isRecord(rule) ||
      typeof rule.sid !== "string" ||
      typeof rule.allow !== "boolean" ||
      typeof rule.inherited !== "boolean"
    ) {
      throw new Error("unrecognized ACL rule");
    }
    return { sid: rule.sid, allow: rule.allow, inherited: rule.inherited };
  });
}

// ---------------------------------------------------------------- helpers

interface ChainComponent {
  readonly path: string;
  readonly isSymbolicLink: boolean;
}

async function existingAncestorChain(
  target: string,
): Promise<ChainComponent[]> {
  const chain: ChainComponent[] = [];
  let current = resolve(target);
  const fsRoot = parse(current).root;
  for (;;) {
    const stats = await lstatOrNull(current);
    if (stats !== null) {
      chain.push({ path: current, isSymbolicLink: stats.isSymbolicLink() });
    }
    if (current === fsRoot) return chain;
    current = dirname(current);
  }
}

async function realpathAllowingMissingTail(target: string): Promise<string> {
  let existing = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      const parent = dirname(existing);
      if (errorCode(error) !== "ENOENT" || parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function comparable(value: string, platform: DataRootPlatform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function refuse(
  code: DataRootTargetRefusalCode,
  reason: string,
): DataRootTargetResult {
  return { ok: false, code, reason };
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
