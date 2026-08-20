import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  readCliManifest,
  type CliInstallManifest,
  type CliInstallSource,
} from "../manifest/cli-manifest";
import type { Environment } from "../runner/environment";
import { cliInstallHomeDir, ensureCliInstallHomeDir } from "./paths";

// The well-known per-environment CLI binary location,
// `<cliInstallHomeDir>/bin/traycer[.exe]`.
//
// This path is a CONTRACT with the host daemon: the host's
// `resolveCliExecutablePath` (traycer-host, update-reconciler) shells the
// CLI for doctor / update / service-status EXCLUSIVELY at this path - it
// reads neither the CLI manifest nor $PATH. An install whose binary lives
// anywhere else (npm global, brew cellar, hand-placed `~/.local/bin`) is
// invisible to the host until something stages this slot, which is what
// `stageWellKnownCliBinary` below exists for.
//
// Mirrors what Desktop's `cliBinDir()` / `cliBinaryName()` helpers and the
// dev orchestrator's per-run `cliBinDir` (scripts/dev-desktop.js,
// `buildDevDesktopRunPaths`) agree on. Windows uses `.exe` for SEA
// binaries; `.cmd` wrappers (dev orchestrator on Windows) are NOT included
// here - Windows service registration goes through Scheduled Tasks via
// `windows.ts`, which has its own convention.
export function wellKnownCliBinaryPath(environment: Environment): string {
  const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
  return join(cliInstallHomeDir(environment), "bin", binaryName);
}

// Whether an install source ships an INTERPRETER SCRIPT rather than an
// executable, and therefore must never be copied into the well-known slot.
//
// npm is the only one today: `@traycerai/cli` publishes a Node bundle
// behind `#!/usr/bin/env node`. Copying it into the slot would put
// JavaScript behind `traycer.exe` on Windows, and on POSIX would leave the
// host daemon spawning a shebang that resolves `node` off the SERVICE
// manager's PATH - the exact failure `npmInterpreterInvocation` avoids for
// the service unit, reintroduced on the host's side of the same install.
//
// This predicate is the single place that decision lives. Every writer of
// the slot consults it, so the resolver and `cli mark-source` cannot drift
// apart on which installs are slot-eligible. (`cli upgrade`'s swap paths
// need no guard - it refuses package-manager-owned sources outright, npm
// among them.)
//
// Retired once npm ships per-platform SEA binaries: npm becomes an ordinary
// executable install and this returns false for every source.
export function isInterpreterDistribution(source: CliInstallSource): boolean {
  return source === "npm";
}

// Whether this process is a compiled single-executable (SEA) binary, i.e.
// the program IS `process.execPath` with no entry script. `node:sea` is
// absent under some interpreters (bun) and under vitest, where the answer
// is "no" anyway.
//
// Lives here rather than in `service/cli-binary.ts` so the slot-refresh
// below can gate on it without importing a module that four suites mock
// wholesale - and so there is exactly one definition of "packaged".
export async function isPackagedRun(): Promise<boolean> {
  try {
    const { isSea } = await import("node:sea");
    return isSea();
  } catch {
    return false;
  }
}

// Re-stage the slot from the running packaged binary when the two have
// diverged. Returns null when nothing was done.
//
// Why this exists separately from the resolver: `resolveServiceCliInvocation`
// re-stages the slot, but every one of its production callers is a service
// REGISTRATION path. A channel whose upgrade replaces the real executable
// without re-registering - winget, whose portable manifest cannot run a
// post-install hook at all - therefore leaves the slot holding the previous
// version's bytes, and ordinary `login` / `host status` runs return through
// auto-bootstrap's already-ready branch without ever resolving. The service
// and the host daemon would keep launching the old CLI indefinitely.
//
// Guards, in order, each cheap enough to sit on every CLI startup:
//
//   - packaged runs only, checked FIRST. An interpreter run (dev, tests)
//     returns before touching the filesystem or reading anything, so no
//     suite can be tricked into copying over a developer's real
//     `~/.traycer` slot.
//   - the slot already IS the authoritative source - the Desktop case,
//     where the anchored binary is the slot itself.
//   - the slot already MIRRORS that source: staging copies the source's
//     mtime onto the slot (see `stageWellKnownCliBinary`), so "same size
//     and same mtime" means the slot is a faithful copy of that exact
//     file. Any upgrade changes one of the two, including a package manager
//     that preserves archive timestamps and happens to ship a same-sized
//     binary - mirroring is what makes an OLDER timestamp detectable, which
//     a `slot newer than source` comparison could not see.
//
// The source is NOT the running process. The CLI manifest is the resolver's
// source of truth, and a machine can have several packaged CLIs installed
// at once; letting whichever one was invoked last win would silently
// repoint both the registered service and the host daemon at a possibly
// OLDER binary. So the manifest's binary wins when it names one, and
// `process.execPath` is the fallback for an install that has no manifest -
// which is the hookless cohort this exists for.
//
// That lookup runs BEFORE any comparison against the running binary, and
// deliberately so. Both of the obvious fast paths - "the running binary IS
// the slot" and "the slot mirrors the running binary" - are true for
// precisely the runs that most need the repair. The registered service and
// the host daemon both launch FROM the slot, so once an anchor has written
// a manifest for a new binary whose staging then failed transiently, every
// subsequent slot-launched command would short-circuit on the stale bytes
// agreeing with themselves, and the machine would stay pinned to them long
// after the filesystem problem cleared. The manifest is the only witness
// that the slot is wrong, so it is consulted first; the cost is one small
// JSON read per packaged startup.
export async function refreshWellKnownSlotIfStale(
  environment: Environment,
): Promise<WellKnownCliStageOutcome | null> {
  if (!(await isPackagedRun())) return null;
  const wellKnownPath = wellKnownCliBinaryPath(environment);
  const source = await authoritativeSlotSource(
    environment,
    resolve(process.execPath),
  );
  if (source === null) return null;
  if (resolve(wellKnownPath) === source) return null;
  const slotStat = await statOrNull(wellKnownPath);
  if (slotStat !== null && (await mirrors(slotStat, source))) return null;
  // A slot that is absent, dangling, or holding something else is repaired
  // here rather than left for the next registration: the service and the
  // host daemon both launch from this path, so on an already-registered
  // machine "no slot" is a broken machine, not a clean one.
  return stageWellKnownCliBinary({ environment, binaryPath: source });
}

// Which binary the slot SHOULD hold. The manifest wins when it names an
// executable that exists; an interpreter distribution (npm) owns no slot at
// all and is reported as such by refusing to nominate a source.
async function authoritativeSlotSource(
  environment: Environment,
  running: string,
): Promise<string | null> {
  let manifest: CliInstallManifest | null;
  try {
    manifest = await readCliManifest(environment);
  } catch {
    // A malformed manifest is this helper's problem to survive, not to
    // report - the commands that own the manifest already diagnose it.
    return running;
  }
  if (manifest === null) return running;
  if (isInterpreterDistribution(manifest.source)) return null;
  const manifestBinary = resolve(manifest.binaryPath);
  return (await statOrNull(manifestBinary)) === null ? running : manifestBinary;
}

// Whether the slot is a faithful copy of `source`, by the identity staging
// writes: same length, same mtime.
//
// Compared at Date (millisecond) precision, NOT via `mtimeMs`. Filesystems
// keep nanoseconds and `mtimeMs` exposes the fraction, but `utimes` accepts
// only a Date - so staging can never reproduce a source's sub-millisecond
// digits, and an `mtimeMs` equality test would report "not mirrored" for a
// slot this module had just written. That would re-copy the whole binary on
// every single command. `getTime()` truncates both sides the same way
// staging did, so a freshly staged slot compares equal.
async function mirrors(slotStat: Stats, source: string): Promise<boolean> {
  const sourceStat = await statOrNull(source);
  if (sourceStat === null) return false;
  return (
    slotStat.size === sourceStat.size &&
    slotStat.mtime.getTime() === sourceStat.mtime.getTime()
  );
}

// Whether two stats of the SAME path describe the same unreplaced file.
//
// Unlike `mirrors` above this compares `mtimeMs` directly, and must: both
// sides come from stat-ing one real file, so there is no `utimes`
// round-trip to truncate away the sub-millisecond digits - and those digits
// are exactly what catches a replacement that landed inside the same
// millisecond as the copy. Inode and device are what catch a same-size,
// same-mtime swap, which is how an atomic `rename` install normally lands.
function isSameFile(before: Stats, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
  );
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export type WellKnownCliStageOutcome =
  // The binary already IS the well-known slot; nothing to do. This guard is
  // what keeps a Desktop-staged slot binary intact when something anchors
  // the slot path itself - without it, staging would replace the real
  // binary with a copy of itself mid-flight.
  | { readonly staged: "already-well-known"; readonly wellKnownPath: string }
  // The slot now holds a fresh COPY of the binary's bytes.
  | { readonly staged: "staged"; readonly wellKnownPath: string }
  // This install ships a script, not an executable
  // (`isInterpreterDistribution`), so the slot is deliberately left alone.
  // Reported rather than silently dropped: the host stays unable to see
  // this install, and callers surface that.
  | { readonly staged: "not-applicable"; readonly wellKnownPath: string }
  // Best-effort failure: the caller's primary contract (manifest write,
  // service registration against the real binary) still holds; only the
  // host's view through this slot stays degraded. Callers surface this.
  | {
      readonly staged: "failed";
      readonly wellKnownPath: string;
      readonly errorName: string;
      readonly errorMessage: string;
    };

// Stage the well-known CLI slot with a COPY of the bytes at `binaryPath`.
// Never throws: staging is an availability upgrade layered on top of the
// caller's primary write, so failure is data, not an abort.
//
// A copy, deliberately NOT a symlink - keep this in lockstep with
// Desktop's `installBundledCli` (clients/desktop .../cli/cli-discovery.ts),
// which is the sibling writer of this same slot and learned both lessons
// in the field:
//
//   - Its POSIX slot used to be a symlink; any target remove/replace left
//     a DANGLING link that lstat still shows while exec fails ENOENT. A
//     copy cannot dangle - if the anchored binary later moves or dies,
//     the slot keeps serving the last-anchored bytes (the accepted
//     stale-but-functional worst case) instead of taking the host's CLI
//     access and the registered service down with it. Freshness is
//     event-driven, not link-driven: every writer of live CLI bytes
//     (mark-source / re-anchor, both `cli upgrade` swap paths, the
//     packaged self-invocation fallback) re-stages this slot.
//   - On Windows the slot binary is routinely the RUNNING image (the
//     registered service launches from it), which holds a delete lock but
//     allows RENAME: move the old image aside, copy into the now-free
//     name, and sweep `.old-*` leftovers once their processes exit.
//
// The staging name is per-invocation (pid + uuid): a fixed temp name is
// shared mutable state between concurrent installers, and rename() is only
// atomic with respect to a source nobody else is writing.
export async function stageWellKnownCliBinary(opts: {
  readonly environment: Environment;
  readonly binaryPath: string;
}): Promise<WellKnownCliStageOutcome> {
  const wellKnownPath = wellKnownCliBinaryPath(opts.environment);
  const source = resolve(opts.binaryPath);
  if (resolve(wellKnownPath) === source) {
    return { staged: "already-well-known", wellKnownPath };
  }
  const staging = `${wellKnownPath}.staging-${process.pid}-${randomUUID()}`;
  // Non-null once the Windows branch has moved a pre-existing slot binary
  // out of the stable name. Between that rename and the publish below the
  // slot does not exist, so a publish failure must put the old binary BACK -
  // see the restore in the catch.
  let asidePath: string | null = null;
  try {
    // Create the install home through its own 0700 helper rather than
    // letting the recursive mkdir below do it. On a fresh packaged install
    // with no manifest - winget and hand-placed binaries, and since the
    // startup refresh, on EVERY packaged command - this is the first writer
    // under the CLI home, and a bare recursive mkdir would create the whole
    // chain at the process umask (0755 typically). Neither this call nor a
    // later `ensureCliInstallHomeDir` repairs the mode of a directory that
    // already exists, so that first run would leave the CLI home
    // world-traversable for the life of the install - the same directory the
    // credentials file sits in, whose 0700 exists precisely to prevent that.
    await ensureCliInstallHomeDir(opts.environment);
    await mkdir(dirname(wellKnownPath), { recursive: true, mode: 0o700 });
    // Stat the source on BOTH sides of the copy. The mtime mirrored below
    // is the whole basis for deciding the slot is fresh, so it has to
    // describe the bytes that actually landed in `staging`. A package
    // manager that atomically replaces `source` mid-copy would otherwise
    // stamp the NEW file's mtime onto a copy of the OLD one - and two
    // same-sized releases would then look mirrored to
    // `refreshWellKnownSlotIfStale` forever, which is the one failure this
    // module cannot detect its way out of.
    const sourceBefore = await statOrNull(source);
    await copyFile(source, staging);
    await sweepSlotLeftovers(wellKnownPath, staging);
    if (process.platform === "win32") {
      asidePath = await renameSlotBinaryAside(wellKnownPath);
    } else {
      await chmod(staging, 0o755);
    }
    // Mirror the source's timestamps onto the copy. This is what lets
    // `refreshWellKnownSlotIfStale` decide freshness by identity rather
    // than by recency: a slot whose (size, mtime) equal its source's is a
    // faithful copy of that exact file, so ANY replacement of the source is
    // detectable - including a package manager that preserves archive
    // timestamps and ships a same-sized binary with an OLDER mtime, which
    // no "is the slot newer?" comparison could ever see.
    //
    // Skipped when the source changed under the copy: the staged file then
    // keeps its own just-now mtime, mirrors nothing, and the next refresh
    // re-stages it. Failing toward one redundant copy is the entire point -
    // failing the other way leaves a permanently stale slot wearing a fresh
    // timestamp. Best-effort otherwise: an unsupported filesystem costs
    // freshness precision, not the staging.
    const sourceAfter = await statOrNull(source);
    if (
      sourceBefore !== null &&
      sourceAfter !== null &&
      isSameFile(sourceBefore, sourceAfter)
    ) {
      await utimes(staging, sourceAfter.atime, sourceAfter.mtime).catch(
        () => undefined,
      );
    }
    await rename(staging, wellKnownPath);
    return { staged: "staged", wellKnownPath };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    // The whole point of copying rather than linking is that the slot
    // degrades to stale-but-functional, never to absent. Publishing is the
    // one window where that can be violated on Windows: the old image is
    // aside and the new one never landed (antivirus holding the staged
    // file, a racing installer, a transient share violation). Put the old
    // binary back so an already-registered service and the host daemon keep
    // launching the CLI they were launching before this attempt.
    if (asidePath !== null) {
      await rename(asidePath, wellKnownPath).catch(() => undefined);
    }
    const named = error instanceof Error ? error : new Error(String(error));
    return {
      staged: "failed",
      wellKnownPath,
      errorName: named.name,
      errorMessage: named.message,
    };
  }
}

// Move a (possibly running) slot binary out of the stable name so a new
// copy can take its place, returning where it went so a failed publish can
// restore it. Windows-only concern: a running image blocks delete and
// rename-onto, but permits being renamed itself. A missing binary (first
// staging) is not an error and yields `null` - there is nothing to restore.
//
// The pid suffix keeps two installers staging in the same millisecond from
// renaming onto each other's aside file and destroying one of them; the
// sweep below matches on the `.old-` prefix alone, so the extra segment
// costs nothing.
async function renameSlotBinaryAside(
  wellKnownPath: string,
): Promise<string | null> {
  const asidePath = `${wellKnownPath}.old-${Date.now()}-${process.pid}`;
  try {
    await rename(wellKnownPath, asidePath);
    return asidePath;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

// Best-effort sweep of this slot's leftovers:
//
//   - `<binary>.old-<ts>-<pid>` from a previous Windows rename-aside.
//     Deletion fails while a renamed image is still executing; those unlock
//     once the old process exits, so each staging pass retries the whole
//     set and the trash never outlives one host generation by much.
//   - `<binary>.staging-<pid>-<uuid>` from a staging that was killed
//     between the copy and the publish. The publish is a rename, so an
//     interrupted attempt can never corrupt the slot itself - but without
//     this the orphaned copies accumulate, one full binary each.
//
// Runs on every platform (the aside files are Windows-only, the staging
// orphans are not) and never throws.
//
// Both prefixes are age-gated, for the same reason and on different clocks.
//
// A `.staging-` file is a copy in flight for whoever created it, and copying
// a ~100 MB binary takes seconds; sweeping those on sight would let one
// installer delete another's half-written copy out from under it. They are
// removed only once far older than any copy could still be running, and this
// invocation's own staging file is skipped outright.
//
// An aside file looks superseded, and mostly is - but not during the window
// that created it. Between `renameSlotBinaryAside` and the publish the aside
// IS the slot's only copy, and the catch in `stageWellKnownCliBinary`
// restores from it precisely so a failed publish cannot leave the slot
// absent. A concurrent staging that swept it on sight would delete that
// rollback copy mid-window, and if both attempts then failed the slot would
// be gone - the one outcome the copy-not-symlink design exists to rule out.
// Concurrency here stopped being hypothetical when the startup refresh
// began staging outside the CLI lock on every packaged command.
//
// Age is read from the NAME, not from `stat`. A rename does not change
// mtime, and staging deliberately mirrors the source's mtime onto the slot,
// so an aside file's mtime is its BINARY's timestamp - which can be months
// old for a fresh rename, and would age-gate to "sweep immediately". The
// `Date.now()` already embedded in the aside name is the only record of when
// the rename actually happened.
const STAGING_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const ASIDE_INFLIGHT_WINDOW_MS = 5 * 60 * 1000;

// Milliseconds encoded in a `<binary>.old-<ts>-<pid>` name, or null when the
// name does not carry one (a leftover from a CLI old enough to predate the
// stamp). Null sweeps, since nothing that shape can belong to a writer
// running this code.
function asideStampedAt(entry: string, asidePrefix: string): number | null {
  const suffix = entry.slice(asidePrefix.length);
  const separator = suffix.indexOf("-");
  const stamp = separator === -1 ? suffix : suffix.slice(0, separator);
  if (stamp.length === 0 || !/^\d+$/.test(stamp)) return null;
  const parsed = Number(stamp);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function sweepSlotLeftovers(
  wellKnownPath: string,
  ownStagingPath: string,
): Promise<void> {
  const dir = dirname(wellKnownPath);
  const name = basename(wellKnownPath);
  const asidePrefix = `${name}.old-`;
  const stagingPrefix = `${name}.staging-`;
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const ownStagingName = basename(ownStagingPath);
  const now = Date.now();
  const stagingCutoff = now - STAGING_ORPHAN_MIN_AGE_MS;
  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry.startsWith(asidePrefix)) {
      const stampedAt = asideStampedAt(entry, asidePrefix);
      // A negative age means the stamp is in the future - a clock that moved
      // backwards - and must not pin the file here forever, so only a
      // plausible, recent age defers the sweep.
      const age = stampedAt === null ? null : now - stampedAt;
      if (age !== null && age >= 0 && age < ASIDE_INFLIGHT_WINDOW_MS) continue;
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    if (!entry.startsWith(stagingPrefix) || entry === ownStagingName) continue;
    let leftover: Stats;
    try {
      leftover = await stat(path);
    } catch {
      continue;
    }
    if (leftover.mtimeMs > stagingCutoff) continue;
    await rm(path, { force: true }).catch(() => undefined);
  }
}
