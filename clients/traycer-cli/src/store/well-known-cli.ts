import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  copyFile,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  readCliManifest,
  type CliInstallManifest,
  type CliInstallSource,
} from "../manifest/cli-manifest";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, isErrnoException } from "../runner/errors";
import { renameWithRetry } from "../installer/rename-retry";
import { resolveCliVersion } from "../cli-version";
import { isStrictlyNewerHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import { errorFromUnknown } from "../logger";
import { withCliLock } from "./cli-lock";
import {
  cliInstallHomeDir,
  ensureCliInstallHomeDir,
  ensurePrivateDir,
} from "./paths";

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
// A slot that passes that last guard with no staging record ADOPTS one, once,
// rather than staying on the timestamp proxy for the rest of its life. See
// `slotRefreshPlan`. That is the only case in which a startup with nothing to
// copy still takes the lock, and only until the record lands.
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
//
// The decision is taken TWICE: once unlocked to answer "is there anything to
// do at all", and again under the CLI lock to answer "is it still true".
//
// Only the second one may act. Copying a ~100 MB binary takes seconds, and a
// package-manager hook re-anchoring the install in that window writes its
// manifest and stages its own binary through `writeMarkSource`, which holds
// this same lock. Without it the slower copy publishes last and leaves the
// slot on the binary the manifest no longer names - not permanently, since
// the next refresh sees the mismatch, but silently until then.
//
// The lock is taken with `waitMs: 0`, never a wait. This runs on every
// packaged command, so blocking startup behind another process's staging
// would be a far worse bug than the one it fixes; contention means some
// other writer is already staging this slot, which is precisely when doing
// nothing is right. A skipped refresh is retried by the next command.
export async function refreshWellKnownSlotIfStale(
  environment: Environment,
): Promise<WellKnownCliStageOutcome | null> {
  return refreshSlot(environment, 0);
}

// How long the supervised entry waits for the lock. See
// `refreshWellKnownSlotForSupervisedStart` for why this one waits at all.
const SUPERVISED_START_LOCK_WAIT_MS = 5_000;

// The same refresh, for the ONE caller that is not a short-lived command:
// `traycer host start`, the long-lived supervised entry.
//
// It waits for the lock where an ordinary command does not, because the cost
// of losing this race is not symmetric. A `traycer agent list` that skips a
// refresh is repaired by the next command a second later. A supervisor that
// skips one keeps executing the previous CLI's image until something restarts
// the service - which on a user's machine may be days, and is exactly the
// stale-supervisor failure this whole change exists to end.
//
// It waits and then PROCEEDS - it does not exit for a retry, and that is a
// deliberate limit rather than an oversight. Exiting on contention would put
// the one long-lived entry point in the product behind a lock another process
// holds, and a lock that can keep a supervisor from ever starting is a worse
// user outcome than a supervisor running last week's bytes: stale-but-running
// beats never-starting, the same rule `stageWellKnownCliBinary` already
// follows when it prefers a stale slot to no slot. The caller logs the
// deferral, and the next command or service restart refreshes.
export async function refreshWellKnownSlotForSupervisedStart(
  environment: Environment,
): Promise<WellKnownCliStageOutcome | null> {
  return refreshSlot(environment, SUPERVISED_START_LOCK_WAIT_MS);
}

// One implementation behind both wrappers on purpose: the two differ only in
// how long they are willing to wait, and a second copy of the decision logic
// is how the two would drift into disagreeing about what "stale" means.
async function refreshSlot(
  environment: Environment,
  lockWaitMs: number,
): Promise<WellKnownCliStageOutcome | null> {
  if (!(await isPackagedRun())) return null;
  const wellKnownPath = wellKnownCliBinaryPath(environment);
  const running = resolve(process.execPath);
  // Cheap unlocked pre-check, so the common "nothing changed" path never
  // touches the lock file at all.
  const planned = await slotRefreshPlan(environment, wellKnownPath, running);
  if (planned.kind === "current") return null;
  try {
    return await withCliLock(
      {
        environment,
        reason: "refresh-well-known-slot",
        // An adoption is never worth WAITING for, whatever the caller's
        // patience. It writes a small record for a slot that is ALREADY a
        // faithful copy, so a wait could only buy a supervisor standing still
        // for seconds over a slot that needs nothing done to it. And whoever
        // holds the lock is either staging - which writes a record of its own,
        // making this adoption moot - or adopting the very same one.
        //
        // Chosen from the UNLOCKED plan, necessarily - the wait is an input
        // to taking the lock, so no locked answer exists yet. The race that
        // implies is narrow and bounded: a plan that was `adopt` at pre-check
        // but becomes `stage` while a holder works forfeits the supervised
        // wait once, loses the lock, and lands in the busy handler below -
        // which re-plans and reports `deferred-busy` honestly, so the skipped
        // wait costs one logged deferral, never a silent one.
        waitMs: planned.kind === "adopt" ? 0 : lockWaitMs,
        pollIntervalMs: 100,
      },
      async () => {
        const plan = await slotRefreshPlan(environment, wellKnownPath, running);
        if (plan.kind === "current") return null;
        if (plan.kind === "adopt") {
          // Under the lock, which is what lets this write fill in the slot
          // half of the record from a fresh stat: Desktop publishes this same
          // path and takes this same lock to do it, so nothing can have
          // replaced the slot since the `lstat` that proved the mirror.
          await writeSlotSourceRecord(
            wellKnownPath,
            plan.source,
            plan.sourceStat,
          );
          return null;
        }
        // A slot that is absent, dangling, or holding something else is
        // repaired here rather than left for the next registration: the
        // service and the host daemon both launch from this path, so on an
        // already-registered machine "no slot" is a broken machine, not a
        // clean one.
        return stageWellKnownCliBinary({
          environment,
          binaryPath: plan.source,
        });
      },
    );
  } catch (error) {
    // Contention ONLY. `withCliLock` throws its `CLI_LOCK_BUSY` error when
    // another writer holds the lock, and that is the expected outcome here -
    // reported as "deferred" rather than "nothing to do" so the supervised
    // caller can say so in its log, since a refresh that was WANTED and could
    // not run is a different machine state from a slot that was already
    // current, and only the first explains a supervisor still on old bytes.
    //
    // But the same call also throws for real filesystem faults on the lock
    // file itself - EACCES on a home whose permissions were changed, EROFS on
    // a read-only mount, EIO on failing storage. A catch-all would report
    // every one of those as "another writer holds the lock": a diagnosis that
    // is not merely incomplete but WRONG, repeated identically on every
    // startup, while the slot stays stale and the actual error never reaches
    // a log. Those surface as `failed`, which the entry already logs with the
    // error's real name and message.
    if (isCliLockBusyError(error)) {
      // An adoption that loses the lock has deferred NOTHING the caller needs
      // to hear about. The slot is a faithful copy either way; the record it
      // wanted to write is a strengthening of the freshness test, not a
      // repair of the bytes. Reporting it as a deferred refresh would put a
      // "the supervisor may be on old bytes" warning in the supervised entry's
      // log for a slot that is current, and would do it on every startup until
      // some run wins the lock.
      //
      // Decided from a FRESH plan, not from `planned` - that one is from
      // before the lock attempt, and the plan changing while a holder works
      // is the very reason the locked callback re-plans. A precheck that saw
      // "adopt" while an install was landing can be looking at a slot that
      // now needs a stage, and answering null there would hide the one log
      // line that explains a supervisor still on old bytes.
      const current = await slotRefreshPlan(
        environment,
        wellKnownPath,
        running,
      );
      if (current.kind !== "stage") return null;
      return { staged: "deferred-busy", wellKnownPath };
    }
    const failure = errorFromUnknown(error);
    return {
      staged: "failed",
      wellKnownPath,
      errorName: failure.name,
      errorMessage: failure.message,
    };
  }
}

// One path in a form two spellings of the same file both reduce to.
//
// By SPELLING, deliberately, where the rest of this change compares inode
// identity. Inode identity would answer the wrong question here: the slot has
// just been republished by `rename`, so the running image is on the old inode
// while the path now leads to a new one - the two are guaranteed to differ
// precisely when the answer should be yes. What is being asked is whether the
// binary this process was launched FROM is the one that got replaced, and
// that is a question about the path.
//
// A bare string compare gets it wrong on Windows in two ways, both of which
// silently skip the restart and leave the supervised host on stale bytes:
// `process.execPath` and a path built from `homedir()` routinely differ in
// case (`C:\Users` vs `c:\users`), and either side can arrive in 8.3 short
// form (`PROGRA~1`). `realpath` collapses the short form; case-folding covers
// the rest, since Windows path comparison is case-insensitive and neither
// `resolve` nor `realpath` reliably normalizes case there. POSIX is
// case-sensitive and must NOT be folded.
//
// Falling back to `resolve` when `realpath` throws is load-bearing rather
// than defensive: on POSIX the running image may already have been unlinked
// by the very rename this is asking about, and an unlinked path cannot be
// realpath-ed.
//
// Exported so the platform-conditional cases can be pinned by unit test
// rather than by spawning a subprocess on an OS the suite may not be
// running on.
export async function canonicalBinaryPath(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => resolve(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

// Whether the image this process is executing came from the well-known slot.
//
// Must be called BEFORE the slot is refreshed - see the call site. Compares
// canonical paths rather than inode identity deliberately: a legacy SYMLINK
// slot and `process.execPath` name one file by two spellings, which is what
// `realpath` collapses, while the inode comparison used elsewhere in this
// change answers a different question ("are these the same file NOW").
export async function isRunningFromWellKnownSlot(
  environment: Environment,
): Promise<boolean> {
  return (
    (await canonicalBinaryPath(process.execPath)) ===
    (await canonicalBinaryPath(wellKnownCliBinaryPath(environment)))
  );
}

// Whether this is the lock module's own "another writer holds it" signal, as
// opposed to a filesystem fault raised while trying to take the lock.
function isCliLockBusyError(error: unknown): boolean {
  return (
    error instanceof CliError && error.code === CLI_ERROR_CODES.CLI_LOCK_BUSY
  );
}

// Whether a refresh run right now would find nothing to copy - the
// convergence probe behind the supervised entry's restart decision.
//
// A `staged` outcome alone is NOT sufficient grounds to exit-and-relaunch,
// and the gap is exactly the two best-effort writes staging is allowed to
// lose: on a volume that cannot reproduce mtimes AND cannot land the
// `.source.json` sidecar, every start would stage "successfully", exit for
// a restart, and the restarted process would find the slot unprovably
// fresh and do it all again - an unbounded supervisor loop re-copying
// ~100 MB per lap, which is the terminating-recovery rule this module is
// under orders to never violate. Re-asking the planner after the stage is
// what makes the exit safe: `current` and `adopt` both mean the next run
// will not copy, so the restart terminates; `stage` means it will, so the
// caller must run stale-but-working instead.
export async function wellKnownSlotRefreshHasConverged(
  environment: Environment,
): Promise<boolean> {
  const plan = await slotRefreshPlan(
    environment,
    wellKnownCliBinaryPath(environment),
    resolve(process.execPath),
  );
  return plan.kind !== "stage";
}

// What a refresh has to do about the slot.
//
// A decision, never an action: this is evaluated once unlocked and again
// under the lock, and only the second evaluation may act on it. Anything
// that writes belongs in `refreshSlot`'s locked callback.
type SlotRefreshPlan =
  // Leave the slot alone - it holds the right bytes, or nothing can be said
  // about what the right bytes would be.
  | { readonly kind: "current" }
  // Copy the slot from `source`.
  | { readonly kind: "stage"; readonly source: string }
  // The slot already mirrors `source`, but carries no record that proves it.
  // Write one from `sourceStat`, the very stat that proved the mirror.
  | {
      readonly kind: "adopt";
      readonly source: string;
      readonly sourceStat: Stats;
    };

// What to do about the slot: stage it, adopt a record for it, or leave it.
async function slotRefreshPlan(
  environment: Environment,
  wellKnownPath: string,
  running: string,
): Promise<SlotRefreshPlan> {
  const nominated = await authoritativeSlotSource(environment, running);
  if (nominated === null) return { kind: "current" };
  const { path: source, anchored } = nominated;
  if (resolve(wellKnownPath) === source) return { kind: "current" };
  // An UNANCHORED nomination - the running binary self-nominated because no
  // manifest vouches for anything - may repair a slot, but must not DEMOTE
  // one. "Whichever binary was invoked last wins" is safe when the slot is
  // absent or older; it is a silent downgrade of the registered service when
  // a stray older SEA (a leftover in ~/Downloads, a superseded winget root)
  // runs one command on a machine whose slot holds a newer CLI. The manifest
  // normally arbitrates exactly this; with none, the only remaining witness
  // is the slot binary itself, so before an unanchored stage over an
  // existing slot binary the slot is asked its version once and left alone
  // when it reports itself STRICTLY newer than this process. An unreadable
  // or unparseable answer stages: the hookless-upgrade cohort this fallback
  // exists for must keep converging, and a slot that cannot say what it is
  // has no seniority to assert.
  //
  // Only ever reached with a REGULAR-FILE slot, since the symlink arm below
  // returns first. That ordering is no longer load-bearing for recursion
  // safety, though it once was argued to be: `slotOutranksRunning` refuses to
  // spawn this process's own image whatever spelling names it, and that is
  // the single place the rule is now stated.
  const guardedStage = async (): Promise<SlotRefreshPlan> => {
    if (!anchored && (await slotOutranksRunning(wellKnownPath))) {
      return { kind: "current" };
    }
    return { kind: "stage", source };
  };
  // `lstat`, not `stat`, and the difference is load-bearing. A slot left as
  // a SYMLINK by an older Desktop is the failure mode copy-not-symlink was
  // adopted to end: `stat` would follow it to the authoritative source and
  // `mirroredSourceStat` would compare that source against itself, report a
  // copy, and leave the link in place forever - until the package manager
  // moved its target and the slot began dangling, taking the registered
  // service and host-side CLI discovery down with it. A symlink is
  // therefore never "already fresh"; it is always restaged into a real
  // file.
  const slotStat = await lstatOrNull(wellKnownPath);
  if (slotStat === null) return { kind: "stage", source };
  if (slotStat.isSymbolicLink()) {
    // De-symlinking must not double as a downgrade. This arm decides what
    // `guardedStage` decides for a regular-file slot - which bytes replace
    // the slot - so it owes the same rule: an unanchored nomination may
    // fill or refresh a slot, never demote one. Copying the running binary
    // over a link that points at a NEWER CLI demotes the registered
    // service, which is the very downgrade the guard exists to prevent.
    //
    // The question is asked of the link's TARGET rather than of the slot
    // because the target is what the bytes ARE - not as a recursion
    // defence, which it never was. Probing either spelling re-enters this
    // planner in the child, since the lexical `resolve(wellKnownPath) ===
    // source` check above cannot see that a symlinked slot and its target
    // name one file. What ends the recursion is `slotOutranksRunning`
    // declining to spawn this process's own image: the child launched as
    // the target asks nothing, stages the slot from itself, de-symlinks it,
    // and answers. Stated once, there.
    //
    // Preserving the target only on a version answer, rather than on
    // `realpath` succeeding, is the other half. Bytes that resolve are not
    // therefore a CLI: a link may point at a shim, another tool, or
    // anything else that survived the years since some installer wrote it,
    // and copying that into the slot hands the registered service and the
    // host a program that will never repair itself - the repair path here
    // runs only when a real CLI is invoked, and after this the thing being
    // invoked is not one. So a target that cannot say what it is loses to
    // the running packaged CLI, which demonstrably can. (What "usable"
    // means is exactly what it means one branch below, and both halves are
    // decided in `slotOutranksRunning`: it answered `--version` with
    // something parseable, AND it is a binary the slot may hold at all -
    // an npm install answers that question perfectly well and still must
    // never be copied here.)
    //
    // Not strictly newer - older, equal, unreadable, dangling - all fall
    // through to the ordinary stage from `source`, which de-symlinks and
    // refreshes in one step. That is also what made copy-not-symlink the
    // rule: a link nobody can vouch for must not survive as one.
    if (!anchored) {
      const target = await realpath(wellKnownPath).catch(() => null);
      if (target !== null && (await slotOutranksRunning(target))) {
        return { kind: "stage", source: target };
      }
    }
    return { kind: "stage", source };
  }
  // The staging record is the authority whenever it applies, because it is
  // the one identity no filesystem can take away: staging writes down what
  // it copied and what it produced, so freshness stops depending on a volume
  // being able to reproduce a timestamp. See `SLOT_SOURCE_RECORD_SUFFIX`.
  const record = await readSlotSourceRecord(wellKnownPath);
  if (record !== null && recordDescribes(record, slotStat, source)) {
    const sourceStat = await statOrNull(source);
    if (sourceStat === null) return { kind: "current" };
    return sourceIsUnchanged(record, sourceStat)
      ? { kind: "current" }
      : guardedStage();
  }
  // No usable record - a slot staged by a CLI older than this format, one a
  // sibling writer published, or one whose best-effort record write failed.
  // Fall back to comparing timestamps.
  //
  // A `false` here stages, which writes a record, so that arm converges on
  // its own. A `true` is the arm that does NOT: "already mirrored" means
  // "do not stage", so a slot that keeps mirroring would keep skipping the
  // stage, never acquire a record, and stay on the size/mtime proxy FOREVER -
  // which is precisely the permanent downgrade the record exists to prevent.
  // A same-size atomic replacement carrying the same mtime (rpm and dpkg both
  // restore archive timestamps) would then read as current indefinitely,
  // stranding the service on the previous CLI.
  //
  // So adopt instead: bind a record to the source's identity as observed
  // right now. State the premise honestly - the fallback proves size and mtime
  // agree, NOT that the bytes do, so adoption inherits whatever the proxy
  // just concluded rather than establishing something stronger. What it buys
  // is the future: every LATER replacement changes the inode and is caught
  // exactly. It is therefore strictly better than the status quo on this
  // path, which is the same conclusion with no way to ever improve on it.
  //
  // Restaging would also converge, and is the more obvious fix, but it costs
  // every already-installed machine a redundant ~100 MB copy to reach a
  // record this can write with one stat and one small JSON write.
  const mirroredSource = await mirroredSourceStat(slotStat, source);
  if (mirroredSource === null) return guardedStage();
  return { kind: "adopt", source, sourceStat: mirroredSource };
}

// Ask a candidate binary its version and answer whether it outranks the
// running process. `true` is the ONLY answer that suppresses an unanchored
// stage, so every failure - a candidate that will not execute, prints
// garbage, or hangs past the timeout - is `false`: refusing to converge on an
// unprovable seniority claim would strand the hookless cohort the fallback
// serves.
//
// NEVER spawns this process's own image, and that check lives here rather
// than at the call sites because it is the whole reason this function is safe
// to call. What gets spawned is a packaged CLI, and a packaged CLI runs this
// same refresh before commander parses `--version` - so a probe of ourselves
// is a probe that re-enters this planner in the child, reaches this line
// again, and spawns another ~100 MB process per level until the timeouts
// unwind, orphaning every descendant deeper than the one `execFile` can kill.
//
// Two call sites have now been written believing a PATH comparison upstream
// made that impossible, and both were wrong in the same way: recursion is a
// question about binary IDENTITY, `resolve` compares SPELLING, and a symlink
// is precisely where one file has two of them. `resolve(wellKnownPath) ===
// source` is only accidentally an identity test - true for a regular-file
// slot, false for a symlinked one naming the very same bytes. So the identity
// test belongs in front of the spawn, once, where no third call site can
// reintroduce it, and `canonicalBinaryPath` is what collapses the spellings.
//
// `false` is not a bail-out here but the exact answer: nothing is strictly
// newer than itself. Its effect - stage - is also right, since bytes
// identical to the running image cannot demote anything, and for the symlink
// arm it is what finally turns a legacy link into the regular file the
// copy-not-symlink rule wants.
async function slotOutranksRunning(candidatePath: string): Promise<boolean> {
  if (
    (await canonicalBinaryPath(candidatePath)) ===
    (await canonicalBinaryPath(process.execPath))
  ) {
    return false;
  }
  // Answering `--version` proves a program runs, not that it may HOLD the
  // slot, and the difference has a rule already: `isInterpreterDistribution`
  // refuses to nominate an npm install at all, because the slot is spawned by
  // the host daemon and the registered service, where a `#!/usr/bin/env node`
  // shebang resolves `node` off the SERVICE manager's PATH rather than a
  // login shell's. That rule is keyed on the MANIFEST, and every caller here
  // is unanchored - no manifest, by definition - so the file has to be asked
  // directly.
  //
  // A version answer is exactly what an npm CLI gives (the shebang runs it),
  // so without this an old Desktop symlink pointing at a newer npm install
  // puts a Node script behind `bin/traycer`, and nothing repairs it: the next
  // packaged run probes that slot, the script answers newer again, and the
  // guard leaves it there forever while the service cannot start. Refusing
  // here is also what makes that state RECOVERABLE if it is ever reached by
  // hand - `false` stages the running SEA over it.
  if (!(await isSlotEligibleBinary(candidatePath))) return false;
  let reported: string;
  try {
    const { stdout } = await execFileAsync(candidatePath, ["--version"], {
      timeout: SLOT_VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    reported = stdout.trim();
  } catch {
    return false;
  }
  return isStrictlyNewerHostVersion(reported, resolveCliVersion(process.env));
}

const SLOT_VERSION_PROBE_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

// Whether a binary may OCCUPY the slot, as opposed to merely being able to
// run. See `isInterpreterDistribution` for the rule this enforces without a
// manifest to read it from.
//
// Deliberately a NEGATIVE test. Proving a file IS a packaged executable means
// recognising Mach-O, ELF and PE magic on every platform this ships to, and
// being wrong there REFUSES a legitimate newer CLI - the silent downgrade
// this whole guard exists to prevent. Being wrong the other way only stages
// the running SEA, which is always a working CLI, and always converges. So
// the question asked is the narrow one the failure is actually about: does
// this file start with a shebang.
//
// Two bytes, not `readFile`: the candidate is a ~100 MB binary in the case
// this runs for.
//
// On Windows the slot is `traycer.exe` and Scheduled Tasks spawns it as an
// image, so a non-`.exe` target - npm's `.cmd`/`.ps1` shims, a bare shell
// script - cannot serve there whatever its first bytes are. Unreadable
// counts as ineligible for the same fail-safe reason.
async function isSlotEligibleBinary(binaryPath: string): Promise<boolean> {
  if (
    process.platform === "win32" &&
    !binaryPath.toLowerCase().endsWith(".exe")
  ) {
    return false;
  }
  // REGULAR FILE first, and this ordering is the load-bearing part. Opening a
  // FIFO for reading BLOCKS until a writer appears - forever, with no
  // deadline of its own, and upstream of the `execFile` timeout that bounds
  // everything else here. Every packaged command awaits this refresh before
  // commander parses argv, so a FIFO at the slot (or a legacy link resolving
  // to one) would hang every CLI invocation on the machine, including the
  // ones that exist to repair it. A wedge with no recovery path is the one
  // outcome this module is under orders never to create.
  //
  // It is also the honest question: the slot must hold an executable image,
  // and a directory, socket, device or FIFO is not one whatever its first
  // bytes would say.
  const candidateStat = await statOrNull(binaryPath);
  if (candidateStat === null || !candidateStat.isFile()) return false;
  let handle: FileHandle;
  try {
    // O_NONBLOCK closes the window between the stat above and this open, in
    // which the candidate could become a FIFO. A no-op for the regular file
    // this is reached with; absent on Windows, which has no FIFO to open
    // this way.
    handle = await open(
      binaryPath,
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK,
    );
  } catch {
    return false;
  }
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return !(bytesRead === 2 && buffer[0] === 0x23 && buffer[1] === 0x21);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// A nominated slot source, and whether an install AUTHORITY vouches for it.
// `anchored: false` marks the two self-nominations - no manifest at all, and
// a manifest whose binary is confirmed gone - where "the running binary" won
// by default rather than by anyone's decision. The planner treats those with
// less trust: they may fill or refresh a slot, never demote one.
interface NominatedSlotSource {
  readonly path: string;
  readonly anchored: boolean;
}

// Which binary the slot SHOULD hold. The manifest wins when it names an
// executable that exists; an interpreter distribution (npm) owns no slot at
// all and is reported as such by refusing to nominate a source.
async function authoritativeSlotSource(
  environment: Environment,
  running: string,
): Promise<NominatedSlotSource | null> {
  let manifest: CliInstallManifest | null;
  try {
    manifest = await readCliManifest(environment);
  } catch {
    // Unreadable is NOT the same as absent, and must not fall back to the
    // running binary. `readCliManifest` returns null for a genuinely absent
    // manifest and throws only for a corrupt one or a real I/O fault
    // (EACCES, EIO). In the fault case the manifest may well name another
    // installation, so treating whichever executable happened to be invoked
    // as authoritative would let a transient read error repoint the slot -
    // and with it the registered service - onto a possibly OLDER co-
    // installed CLI. Nominating nothing leaves the slot exactly as it was,
    // which is the only safe answer when the authority cannot be consulted.
    // The commands that own the manifest already diagnose it.
    return null;
  }
  if (manifest === null) return { path: running, anchored: false };
  if (isInterpreterDistribution(manifest.source)) return null;
  const manifestBinary = resolve(manifest.binaryPath);
  // Only a CONFIRMED absence may demote the manifest's binary. `statOrNull`
  // would report an EACCES or EIO on B as indistinguishable from "B is not
  // there", and the fallback would then hand the slot to whichever binary
  // happened to be running - so a transient fault reading the manifested
  // install is all it would take to repoint the slot, and the registered
  // service with it, onto a possibly older co-installed CLI. Same rule as
  // the manifest read above: unreadable is not absent.
  switch (await probePresence(manifestBinary)) {
    case "present":
      return { path: manifestBinary, anchored: true };
    case "absent":
      // The manifested binary is confirmed GONE, so the manifest vouches for
      // nothing this fallback can use - the self-nomination is exactly as
      // unanchored as the no-manifest case and gets the same reduced trust.
      return { path: running, anchored: false };
    case "unknown":
      return null;
  }
}

type PathPresence = "present" | "absent" | "unknown";

async function probePresence(path: string): Promise<PathPresence> {
  try {
    await stat(path);
    return "present";
  } catch (error) {
    return isEnoentError(error) ? "absent" : "unknown";
  }
}

// One spelling of the errno narrow for this module, built on the shared
// `isErrnoException` rather than a third hand-rolled null/typeof dance -
// `renameSlotBinaryAside` consults it too, so "is this an ENOENT" cannot
// drift between the two places the answer matters.
function isEnoentError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
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
//
// Fallback freshness for a slot with no staging record: same length, same
// mtime. Nothing is inferred from a null beyond "cannot prove fresh" - the
// caller stages, which writes a record, and from then on the record answers
// this question exactly. An unreadable source is one such null, and stages
// for the same reason it always did: this cannot prove anything about a file
// it cannot stat, and `stageWellKnownCliBinary` reports the real fault.
//
// Returns the stat that PROVED the mirror rather than a bare boolean, so an
// adopting caller can bind its record to that same observation. Re-stat-ing
// would sample the source a second time and could record an identity the
// slot was never compared against - see `writeSlotSourceRecord`, which
// declines the same third sample for the same reason.
async function mirroredSourceStat(
  slotStat: Stats,
  source: string,
): Promise<Stats | null> {
  const sourceStat = await statOrNull(source);
  if (sourceStat === null) return null;
  const mirrored =
    slotStat.size === sourceStat.size &&
    slotStat.mtime.getTime() === sourceStat.mtime.getTime();
  return mirrored ? sourceStat : null;
}

// What staging copied, and what it produced.
//
// Mirroring the source's mtime onto the copy made freshness checkable, but
// only on volumes that can actually store the value they are handed - a
// filesystem without `utimes`, or with coarser granularity, silently rounds
// it, and then no comparison of the two stats can distinguish "the source
// was replaced" from "this volume cannot reproduce the timestamp". Either
// answer is wrong somewhere: one re-copies ~100 MB on every command forever,
// the other misses a same-size upgrade forever.
//
// Writing the identity down removes the question. The source's identity is
// recorded as it was AT STAGING TIME, so a later run compares a fresh stat of
// the source against numbers this module chose - no round trip through the
// filesystem's timestamp support, and a replacement is detected even when it
// is byte-identical in length and carries an OLDER mtime.
//
// Identity, not just metadata, and the inode/device pair is the load-bearing
// half. Size and mtime are a PROXY for "the same bytes" and every proxy has
// collisions: two releases of a Go/Node SEA routinely pad to the same length,
// and rpm and dpkg both restore the archive's recorded mtime onto the file
// they install - so a same-size upgrade can reproduce BOTH numbers and read
// as unchanged forever, stranding the service on the previous CLI. What no
// package manager reproduces is the inode, because none of them rewrite a
// live binary in place: apt, dnf, brew, npm, Scoop and winget all write a new
// file and `rename` it over the old one, which by definition allocates a new
// inode. Recording `ino`/`dev` therefore catches the replacement shape that
// actually occurs, rather than the shape a metadata comparison can see.
//
// The limit, stated so the next reader does not have to rediscover it: this
// still cannot see an in-place rewrite that preserves size, mtime AND inode.
// Only hashing the bytes could, and hashing a ~100 MB SEA on every command to
// close a shape no installer produces is not a trade this path can make.
//
// The slot's own size and mtime are recorded too, and checked first. That is
// what keeps the record honest when something else writes the slot: Desktop
// publishes this same path, and a record describing bytes that are no longer
// there would otherwise vouch for a stale slot. A mismatch discards the
// record rather than trusting it.
interface SlotSourceRecord {
  readonly sourcePath: string;
  readonly sourceSize: number;
  readonly sourceMtimeMs: number;
  readonly sourceIno: number;
  readonly sourceDev: number;
  readonly slotSize: number;
  readonly slotMtimeMs: number;
}

// Whether `sourceStat` is still the file the slot was staged from.
//
// `ino`/`dev` are compared alongside size and mtime rather than instead of
// them: Windows reports `ino` as 0 on filesystems that expose no file index,
// where this correctly degrades to the size/mtime test rather than declaring
// every source replaced (0 === 0) or unchanged.
function sourceIsUnchanged(
  record: SlotSourceRecord,
  sourceStat: Stats,
): boolean {
  return (
    sourceStat.size === record.sourceSize &&
    sourceStat.mtimeMs === record.sourceMtimeMs &&
    sourceStat.ino === record.sourceIno &&
    sourceStat.dev === record.sourceDev
  );
}

function slotSourceRecordPath(wellKnownPath: string): string {
  return `${wellKnownPath}${SLOT_SOURCE_RECORD_SUFFIX}`;
}

// `mtimeMs` here, deliberately, where `mirroredSourceStat` must not: both are
// this module's own observations of one real file, with no `utimes` round
// trip in between to truncate the precision away.
function recordDescribes(
  record: SlotSourceRecord,
  slotStat: Stats,
  source: string,
): boolean {
  return (
    record.sourcePath === source &&
    record.slotSize === slotStat.size &&
    record.slotMtimeMs === slotStat.mtimeMs
  );
}

async function readSlotSourceRecord(
  wellKnownPath: string,
): Promise<SlotSourceRecord | null> {
  let raw: string;
  try {
    raw = await readFile(slotSourceRecordPath(wellKnownPath), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  // Every field is required, which is also the upgrade path: a record written
  // by a CLI that predates `sourceIno`/`sourceDev` is rejected here, sending
  // that slot down the timestamp fallback exactly once. That fallback ends in
  // a current record either way - by staging when it cannot prove freshness,
  // by adopting when it can - so the older format costs one pass, never a
  // permanent downgrade to the weaker test.
  if (
    typeof value.sourcePath !== "string" ||
    typeof value.sourceSize !== "number" ||
    typeof value.sourceMtimeMs !== "number" ||
    typeof value.sourceIno !== "number" ||
    typeof value.sourceDev !== "number" ||
    typeof value.slotSize !== "number" ||
    typeof value.slotMtimeMs !== "number"
  ) {
    return null;
  }
  return {
    sourcePath: value.sourcePath,
    sourceSize: value.sourceSize,
    sourceMtimeMs: value.sourceMtimeMs,
    sourceIno: value.sourceIno,
    sourceDev: value.sourceDev,
    slotSize: value.slotSize,
    slotMtimeMs: value.slotMtimeMs,
  };
}

// Best-effort, and ordered after the publish on purpose: a record that never
// lands just sends the next run down the timestamp fallback, whereas a
// record written before a publish that then failed would vouch for bytes
// that never arrived.
//
// `sourceIdentity` is passed in rather than re-stat-ed here, and that is the
// whole correctness argument for this function. Re-stat-ing would sample the
// source one time too many: if a package manager replaced A with B while the
// caller was working, the slot holds A's bytes while a fresh stat describes
// B, and the record would then vouch for the stale slot against B's identity
// - which B keeps matching, so the slot would never be refreshed again. Each
// caller passes the stat its own reasoning was carried out against.
//
// Two callers, resting on premises of DIFFERENT strength, and the difference
// is worth stating because the record itself cannot express it. Staging
// passes the stat it PROVED describes the bytes it copied, and declines to
// call this at all when it could prove no such thing. Adoption
// (`slotRefreshPlan`) passes the stat that proved only same-size, same-mtime
// against a slot some other writer published - so the record it lays down is
// exactly as good as that proxy, no better. That is still the right trade
// there: the alternative on that path is a slot that consults the proxy
// forever and can never improve, whereas one record turns every LATER
// replacement into an exact inode comparison.
async function writeSlotSourceRecord(
  wellKnownPath: string,
  source: string,
  sourceIdentity: Stats,
): Promise<void> {
  const slotStat = await statOrNull(wellKnownPath);
  if (slotStat === null) return;
  const record: SlotSourceRecord = {
    sourcePath: source,
    sourceSize: sourceIdentity.size,
    sourceMtimeMs: sourceIdentity.mtimeMs,
    sourceIno: sourceIdentity.ino,
    sourceDev: sourceIdentity.dev,
    slotSize: slotStat.size,
    slotMtimeMs: slotStat.mtimeMs,
  };
  await writeFile(
    slotSourceRecordPath(wellKnownPath),
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8", mode: 0o600 },
  ).catch(() => undefined);
}

// Whether two stats of the SAME path describe the same unreplaced file.
//
// Unlike the fallback above this compares `mtimeMs` directly, and must: both
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

// Deliberately does NOT follow symlinks - see `slotRefreshPlan` for why
// the slot has to be inspected as the directory entry it is rather than as
// whatever it points at.
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
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
  // A refresh was WANTED but another writer held the CLI lock, so nothing was
  // read or written. Distinct from every outcome above, all of which mean the
  // slot is in the state it should be: this one means it may not be, and
  // nobody checked. Produced only by the refresh path - `stageWellKnownCliBinary`
  // is called with the lock already held and never returns it.
  | { readonly staged: "deferred-busy"; readonly wellKnownPath: string }
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
    // Create the install home through its own helper first, rather than
    // letting the bin-dir call below create the whole chain. A recursive
    // create only applies its mode to the directories it makes, so the
    // intermediate CLI home would land at the process umask (0755 typically)
    // and stay there. On a fresh packaged install with no manifest - winget
    // and hand-placed binaries, and since the startup refresh, on EVERY
    // packaged command - this is the first writer under that directory, which
    // is where the credentials file sits.
    //
    // Both calls REPAIR an existing directory's mode as well as setting it on
    // create (see `ensurePrivateDir`): `mkdir` alone would harden only
    // machines with no Traycer install yet, leaving every already-installed
    // user - the ones with credentials already on disk - at whatever mode the
    // first writer happened to pick.
    await ensureCliInstallHomeDir(opts.environment);
    await ensurePrivateDir(dirname(wellKnownPath));
    // Stat the source on BOTH sides of the copy. Everything this function
    // writes down about freshness - the mirrored mtime below and the staging
    // record after the publish - is a claim about which file's bytes landed
    // in `staging`, so it has to be made against a stat that demonstrably
    // describes them. A package manager that atomically replaces `source`
    // mid-copy would otherwise attribute the NEW file's identity to a copy of
    // the OLD one, and `refreshWellKnownSlotIfStale` would keep matching that
    // identity and keep declaring the stale slot current - the one failure
    // this module cannot detect its way out of afterwards.
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
    // The one stat PROVEN to describe the bytes now sitting in `staging`, or
    // null when the source moved under the copy and no such stat exists.
    const copiedSource =
      sourceBefore !== null &&
      sourceAfter !== null &&
      isSameFile(sourceBefore, sourceAfter)
        ? sourceAfter
        : null;
    if (copiedSource !== null) {
      await utimes(staging, copiedSource.atime, copiedSource.mtime).catch(
        () => undefined,
      );
    }
    // `renameWithRetry`, not a bare rename: Windows releases a dead
    // process's handles asynchronously, and staging often runs right after
    // a service stop with antivirus scanning the fresh copy - the exact
    // transient EBUSY/EPERM window installer/rename-retry.ts exists for. A
    // single-attempt publish would report that hiccup as a failed staging.
    await renameWithRetry(staging, wellKnownPath);
    // Deliberately no record when the copy raced a replacement. The next run
    // finds none and falls back to the timestamp test - which the skipped
    // `utimes` above makes FAIL - and restages. That costs one redundant copy;
    // writing a record anyway would cost a slot that is permanently stale and
    // permanently sure it is not.
    //
    // The skipped `utimes` is doing double duty now that the fallback can
    // ADOPT a record instead of only staging. An un-mirrored slot fails the
    // size/mtime test, so it can never be adopted either - which matters more
    // than it used to, because an adoption here would bind a record to the
    // RACING replacement's identity and reach exactly the permanent staleness
    // this branch declines to write. Both escapes from this state are closed
    // by the same one line not running.
    if (copiedSource !== null) {
      await writeSlotSourceRecord(wellKnownPath, source, copiedSource);
    }
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
      // Retried hardest of the three renames, because this is the one whose
      // single-attempt failure is not a degraded outcome but the forbidden
      // one: the publish already failed, so a transient EBUSY here - the
      // old image's handles still being released - would leave the slot
      // ABSENT. The outer catch stays: after the retries are exhausted
      // there is genuinely nothing more this path can do, and the failure
      // report below already carries the original error.
      await renameWithRetry(asidePath, wellKnownPath).catch(() => undefined);
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
    // Retried for the same Windows transient-handle window as the publish
    // rename. ENOENT is not in the retry set, so the first-staging case
    // still reaches the handler below on the first attempt.
    await renameWithRetry(wellKnownPath, asidePath);
    return asidePath;
  } catch (error) {
    if (isEnoentError(error)) {
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
// Every writer of this slot does hold the CLI lock today, which makes the
// window unreachable in-process - the age gate is defence in depth for the
// callers the lock cannot see: a crashed holder whose lock was reclaimed
// mid-publish, and any future writer that forgets the lock contract.
//
// Age is read from the NAME, not from `stat`. A rename does not change
// mtime, and staging deliberately mirrors the source's mtime onto the slot,
// so an aside file's mtime is its BINARY's timestamp - which can be months
// old for a fresh rename, and would age-gate to "sweep immediately". The
// `Date.now()` already embedded in the aside name is the only record of when
// the rename actually happened.
const STAGING_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const ASIDE_INFLIGHT_WINDOW_MS = 5 * 60 * 1000;
// Sits beside the slot, named after it. Not swept: the sweep matches the
// `.old-` / `.staging-` prefixes, and this is neither.
const SLOT_SOURCE_RECORD_SUFFIX = ".source.json";

// Milliseconds encoded in a `<binary>.old-<ts>-<pid>` or
// `.mtime-probe-<ts>-<pid>-<uuid>` name, or null when the name does not carry
// one (a leftover from a CLI old enough to predate the stamp). Null sweeps,
// since nothing that shape can belong to a writer running this code.
function leftoverStampedAt(entry: string, prefix: string): number | null {
  const suffix = entry.slice(prefix.length);
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
      const stampedAt = leftoverStampedAt(entry, asidePrefix);
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
