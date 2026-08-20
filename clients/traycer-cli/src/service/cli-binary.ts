import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import type { Environment } from "../runner/environment";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
import { readCliManifest } from "../manifest/cli-manifest";
import {
  isInterpreterDistribution,
  isPackagedRun,
  stageWellKnownCliBinary,
  wellKnownCliBinaryPath,
} from "../store/well-known-cli";

// Resolve the stable per-user CLI binary that OS service manifests
// should invoke.
//
// The registered command is the well-known slot
// (`<cliInstallHomeDir>/bin/traycer`) for every EXECUTABLE install, no
// matter which of the sources below identified that executable. Two
// reasons, both load-bearing:
//
//   - The host daemon's own CLI discovery (`resolveCliExecutablePath`,
//     traycer-host update-reconciler) reads ONLY that slot. A registration
//     that names any other path leaves the host reporting `cli-unavailable`
//     for doctor / update-check / update-install - the GUI's "has no
//     Traycer CLI installed" banner - even though the service itself runs.
//   - The slot is stable across upgrades in a way the real binary path is
//     not: Homebrew cellar paths and npm/winget install roots are
//     version-scoped, so a unit that names one breaks the moment the
//     package manager moves it. Every writer of live CLI bytes re-stages
//     the slot, so pointing the unit there survives upgrades without
//     re-registration.
//
// Discovery order for WHICH executable's bytes belong in that slot:
//
//   1. CLI manifest at `<cliInstallHomeDir>/manifest.json` - written by the
//      Desktop bootstrap, `cli mark-source` (package-manager install
//      hooks), and `cli re-anchor`; also SYNTHESIZED by `readCliManifest`
//      for distributions that never get to run a hook (the npm env shim,
//      the .deb/.rpm `/var/lib/traycer/source.*` markers). Source of truth
//      when present. The npm distribution is the one non-executable case -
//      an interpreter-run Node bundle - and is handled separately by
//      `npmInterpreterInvocation`; it never reaches the slot.
//   2. The running process, when it is a PACKAGED (SEA) binary. Deliberately
//      ahead of an existing slot binary: an already-staged slot is a COPY,
//      and channels with no post-install hook (winget's portable installer)
//      upgrade the real executable without touching it. Re-staging from the
//      running binary is what keeps the slot - and therefore the service and
//      the host - off an indefinitely stale CLI.
//   3. An existing slot binary, for INTERPRETER runs only. This is how the
//      dev orchestrator hands off (`scripts/dev-desktop.js` stages a bun
//      wrapper at `~/.traycer/cli/dev-runs/<slot>/bin/traycer` when
//      `DEV_DESKTOP_SLOT` is present) without any flag or env-var coupling.
//   4. Self-invocation for an interpreter run (tsx dev, smoke tests), which
//      must opt in via `allowSelfInvocation`. A packaged binary never needs
//      the flag - (2) already covers it.

export interface CliInvocation {
  // Absolute path to the executable the OS service should run.
  readonly command: string;
  // Leading arguments inserted before `host start ...` - typically
  // empty for a SEA binary, or `[<entry-source>]` for the dev tsx shim.
  readonly args: readonly string[];
}

export interface ResolveCliInvocationOptions {
  readonly environment: Environment;
  // Caller-supplied override. Kept as a parameter on the function
  // signature but no longer surfaced as a CLI flag - the well-known
  // bin-dir convention below has subsumed every legitimate caller.
  // Programmatic in-process callers can still pass an explicit
  // override when needed.
  readonly override: string | null;
  // When true and no manifest / bin-dir binary is found, allow an
  // INTERPRETER run (tsx dev, smoke tests) to register the currently
  // running process (`process.execPath` plus the entry script). A
  // packaged (SEA) binary never needs this flag: self-invocation is
  // always safe for it, so npm/brew/hand-placed installs register
  // without ever staging `~/.traycer` first.
  readonly allowSelfInvocation: boolean;
}

// Every caller below is asking one question: is there something at this path
// that can be REGISTERED as a service command (or copied into the slot to
// become one)? `access()` cannot answer it - it succeeds for a directory, and
// a directory is exactly what the slot degrades to when a botched install or
// a hand-rolled `mkdir ~/.traycer/bin/traycer` gets there first. Registering
// one produces a unit systemd and launchd accept and can never start, on a
// path nothing rewrites afterwards.
//
// `stat`, not `lstat`: a symlink pointing at a real binary is a legitimate
// registration target (a distro's `/usr/local/bin/traycer` into a versioned
// keg, the dev orchestrator's wrapper), and reports `isFile()` through the
// link. What this rejects is a path that is not a regular file under any
// interpretation - a directory, a socket, a dangling link.
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveServiceCliInvocation(
  opts: ResolveCliInvocationOptions,
): Promise<CliInvocation> {
  if (opts.override !== null) {
    if (!(await isRegularFile(opts.override))) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
        message: `service install: override path is not a file: ${opts.override}`,
        details: { override: opts.override },
        exitCode: 1,
      });
    }
    return { command: opts.override, args: [] };
  }

  const manifest = await readCliManifest(opts.environment);
  if (manifest !== null) {
    if (!(await isRegularFile(manifest.binaryPath))) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
        message: `service install: CLI manifest binaryPath is not a file: ${manifest.binaryPath}`,
        details: {
          binaryPath: manifest.binaryPath,
          environment: opts.environment,
        },
        exitCode: 1,
      });
    }
    // An interpreter distribution (npm) ships a script, not an executable,
    // so it must never be copied into the slot - see
    // `isInterpreterDistribution`, the single place that rule lives. It
    // keeps the direct-path registration, with the interpreter pinned when
    // we can see it. Once npm ships per-platform SEA binaries the predicate
    // goes false for every source and this falls through to the staging
    // below with everything else.
    if (isInterpreterDistribution(manifest.source)) {
      const interpreted = await npmInterpreterInvocation(manifest);
      if (interpreted !== null) return interpreted;
      // No conforming interpreter on THIS process's PATH. What that proves
      // differs by platform, and the response must too.
      //
      // POSIX: register the script directly, with a warning. The resolver's
      // PATH is not authoritative for the unit - a host-driven
      // re-registration or a stripped shell resolves here with a minimal
      // PATH while the systemd user manager's own environment may hold a
      // perfectly good node (`import-environment PATH` is a documented
      // setup) - so refusing would convert installs that launched fine
      // yesterday, and would keep launching, into hard errors on the next
      // re-registration. The shebang gives the unit a second lookup this
      // process cannot perform; stale-but-working beats never-registering,
      // the same recovery rule the slot staging follows.
      //
      // Windows: refuse. A `.js` is not executable there under any PATH, so
      // the registration is not a command that might work - it is one we
      // know cannot, and a unit that reports "installed" and never launches
      // is strictly worse than an error naming the reason.
      if (process.platform !== "win32") {
        createCliLogger(opts.environment).warn(
          "npm CLI registration falling back to the bare script - no conforming node on this process's PATH; the service will resolve its interpreter via the shebang at launch",
          {
            binaryPath: manifest.binaryPath,
            minNodeVersion: MIN_NODE_VERSION.join("."),
            environment: opts.environment,
          },
        );
        return { command: manifest.binaryPath, args: [] };
      }
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
        message:
          `service install: this CLI is recorded as an npm install, which ships a Node script rather than an executable, and no 'node' was found on PATH meeting the required version (>= ${MIN_NODE_VERSION.join(".")}) to pin into the service definition. ` +
          `Windows cannot execute ${manifest.binaryPath} directly, so registering it without an interpreter would create a service that can never launch. ` +
          `Put 'node' on PATH, or re-run this from the npm-installed CLI itself so its own interpreter can be recorded.`,
        details: {
          binaryPath: manifest.binaryPath,
          source: manifest.source,
          environment: opts.environment,
        },
        exitCode: 1,
      });
    }
    return stagedSlotInvocation(opts.environment, manifest.binaryPath);
  }

  const conventionalBinary = wellKnownCliBinaryPath(opts.environment);
  const packaged = await isPackagedRun();

  // Self-invocation for a packaged binary: the running binary IS the whole
  // program, so the service gets `<slot> host start` with no leading args.
  //
  // A packaged binary's `process.argv[1]` is the raw invocation spelling
  // (`traycer`, `./traycer`, an absolute path) - never an entry script - so
  // the interpreter walk below would emit `<execPath> traycer host start`
  // and every launch would die on `error: unknown command 'traycer'`.
  //
  // This runs BEFORE the existing-slot check on purpose: preferring a slot
  // that is already populated would pin the service to whatever binary last
  // staged it, and channels without a post-install hook (winget) replace the
  // real executable without ever re-staging. Restaging from the live binary
  // is a no-op (`already-well-known`) when this process IS the slot, which
  // is the Desktop and host-daemon case.
  if (packaged) {
    return stagedSlotInvocation(opts.environment, process.execPath);
  }

  // Interpreter run with a slot already staged - the dev orchestrator's
  // wrapper-script handoff. Left as a direct reference: a dev wrapper is not
  // ours to copy over itself.
  if (await isRegularFile(conventionalBinary)) {
    return { command: conventionalBinary, args: [] };
  }

  if (!opts.allowSelfInvocation) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
      message: `service install: no CLI manifest at <cliHomeDir>/manifest.json and no binary at ${conventionalBinary}; stage a CLI binary at the well-known location, run from a packaged CLI, or pass --allow-self-invocation for an interpreter-run dev CLI`,
      details: { environment: opts.environment, conventionalBinary },
      exitCode: 1,
    });
  }

  // Interpreter run (tsx dev, smoke tests): walking argv re-uses the same
  // tsx-shebanged entry that's already on disk, so the supervisor command
  // becomes `<node|bun> <entry> host start`.
  const command = process.execPath;
  const entryArg = process.argv[1];
  const args: readonly string[] =
    typeof entryArg === "string" ? [entryArg] : [];
  return { command, args };
}

// Stage `binaryPath`'s bytes into the well-known slot and register the
// service against the SLOT, so both the supervisor and the host daemon read
// the same stable path.
//
// Staging is best-effort, but the fallback is NOT simply "register the real
// binary". The slot is the only path stable across upgrades: Homebrew
// cellar kegs, Scoop app dirs and winget install roots are all
// version-scoped, and nothing rewrites a service definition after the fact
// - on macOS `host update` deliberately PRESERVES the registered invocation
// (see `install-lifecycle.ts`), which is the same platform Homebrew lives
// on. A keg path baked in here therefore outlives every subsequent upgrade
// until brew removes that keg, at which point the service starts failing on
// a command that no longer exists.
//
// So a failed staging prefers an EXISTING slot binary over the real path,
// even though its bytes may be older: stale-but-functional is this slot's
// accepted worst case (see `stageWellKnownCliBinary`), it is the one path
// the host daemon can see, and `refreshWellKnownSlotIfStale` repairs the
// bytes on the next command. Only with no slot at all does the real binary
// path get registered - the alternative there is a definition naming
// nothing, and a working service on a version-scoped path beats no service.
// That last case is logged, so the eventual breakage has a recorded cause
// rather than presenting as a service that mysteriously stopped launching.
// How long the slot's execute probe may take before it is treated as
// inconclusive. Generous on purpose: a cold ~100 MB SEA on a loaded machine
// is slow, and the wrong answer here demotes a working slot.
const execFileAsync = promisify(execFile);

const SLOT_EXEC_PROBE_TIMEOUT_MS = 10_000;

// Whether this path can actually be EXECUTED - answered by executing it,
// because nothing cheaper answers it.
//
// `access(X_OK)` does not: on Linux it reports the file's permission bits and
// succeeds on a `noexec` mount, so the refusal only ever appears at `execve`.
// That is precisely the case worth catching, since a copy into a noexec home
// succeeds at every step and produces a slot that no supervisor can start.
//
// Conservative in one direction deliberately. A clean run says yes. A spawn
// the OS REFUSED says no - EACCES on a noexec mount, ENOEXEC on a corrupt or
// wrong-architecture copy, EPERM under a policy module. Anything else says
// YES: a timeout on a loaded machine, or a non-zero exit from a binary that
// ran perfectly well and disliked its arguments, are not evidence the
// supervisor cannot start it, and answering "no" there would demote a working
// slot to a version-scoped path over an unrelated hiccup.
async function canExecute(path: string): Promise<boolean> {
  try {
    await execFileAsync(path, ["--version"], {
      timeout: SLOT_EXEC_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    return !isSpawnRefusal(error);
  }
}

function isSpawnRefusal(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === "EACCES" ||
      error.code === "ENOEXEC" ||
      error.code === "EPERM")
  );
}

async function stagedSlotInvocation(
  environment: Environment,
  binaryPath: string,
): Promise<CliInvocation> {
  const staged = await stageWellKnownCliBinary({ environment, binaryPath });
  if (staged.staged !== "failed") {
    // A copy that landed is not the same as a binary that runs, and the gap
    // between those two has a real population: a hardened Linux install with
    // `/home` mounted `noexec`. The copy succeeds, the chmod succeeds,
    // staging reports success - and the resulting unit dies at `ExecStart`
    // with an execution error even though the package manager's own binary in
    // `/usr/bin` was perfectly runnable. Registering the slot there converts a
    // working install into a service that can never start, on a path nothing
    // rewrites afterwards.
    //
    // Affordable exactly here and nowhere else: this is service REGISTRATION,
    // once per install, not the per-command refresh path.
    //
    // Skipped when the SOURCE is the slot itself - `already-well-known`
    // means exactly that path equality, nothing about which binary this
    // process is running. The skip is still sound, but for a different
    // reason than "we are executing those bytes": with source === slot the
    // demotion arm below has nothing distinct to demote to, so probing
    // could only burn up to two 10s spawns to arrive at the identical
    // registration the skip returns immediately.
    if (
      staged.staged === "already-well-known" ||
      (await canExecute(staged.wellKnownPath))
    ) {
      return { command: staged.wellKnownPath, args: [] };
    }
    // The slot will not run. Demote ONLY if the source actually would,
    // because the slot is otherwise still the better registration: it is the
    // one path stable across upgrades, and trading it for a version-scoped
    // path that ALSO cannot run gives up that stability for nothing. The
    // reported failure is specifically the asymmetric one - the package
    // manager's binary in `/usr/bin` runs, the copy under a `noexec` home
    // does not - and this is the condition that identifies it.
    if (!(await canExecute(binaryPath))) {
      return { command: staged.wellKnownPath, args: [] };
    }
    createCliLogger(environment).warn(
      "staged CLI slot cannot be executed - registering the source binary instead",
      {
        environment,
        binaryPath,
        wellKnownPath: staged.wellKnownPath,
      },
    );
    return { command: binaryPath, args: [] };
  }
  // A regular file, not merely a path that exists. Staging fails when the
  // slot has been replaced by a DIRECTORY (the rename cannot land on it), and
  // that is precisely the case where an existence test would send the service
  // definition to something no supervisor can execute.
  if (await isRegularFile(staged.wellKnownPath)) {
    return { command: staged.wellKnownPath, args: [] };
  }
  createCliLogger(environment).warn(
    "service CLI registered against an unstaged binary path",
    {
      environment,
      binaryPath,
      wellKnownPath: staged.wellKnownPath,
      errorName: staged.errorName,
      errorMessage: staged.errorMessage,
    },
  );
  return { command: binaryPath, args: [] };
}

// The npm distribution ships a Node bundle, not a SEA: its manifest
// (usually SYNTHESIZED by `readCliManifest` from the
// `TRAYCER_CLI_DISTRIBUTION="npm"` shim that `build-cli-npm.cjs` prepends
// to the built bundle, since the npm package has no install hook) points at
// the shebanged bundle script. Registering that script directly makes the
// service depend on `node` being on the SERVICE MANAGER's PATH - false for
// nvm / asdf installs under systemd, so the unit dies with ENOENT while the
// CLI works fine interactively. Pin an absolute interpreter instead:
// `<node> <bundle> host start`.
//
// Two ways to find one, in descending confidence:
//
//   1. This process IS the bundle - the shim env is set and we are not a
//      packaged binary, so `process.execPath` is the very interpreter
//      running it. Exact by construction.
//   2. Otherwise the first executable `node` on the resolving user's PATH.
//      A PERSISTED npm manifest is what reaches this arm: `cli mark-source
//      --source npm` writes one, and every later resolution from a
//      different process - a packaged CLI sharing the machine, a
//      re-registration driven by `host update` - reads it without the shim
//      env. It is a guess, but it is the same interpreter the bundle's own
//      shebang would select for this user, and an absolute path is exactly
//      what the service manager cannot work out for itself.
//
// Null only when neither is available, which the caller turns into a refusal
// rather than a direct-script registration - there is no third option that
// launches. Superseded once npm ships per-platform SEA binaries.
async function npmInterpreterInvocation(manifest: {
  readonly binaryPath: string;
  readonly source: string;
}): Promise<CliInvocation | null> {
  if (manifest.source !== "npm") return null;
  if (
    process.env.TRAYCER_CLI_DISTRIBUTION === "npm" &&
    !(await isPackagedRun())
  ) {
    return { command: process.execPath, args: [manifest.binaryPath] };
  }
  const interpreter = await resolveNodeOnPath();
  return interpreter === null
    ? null
    : { command: interpreter, args: [manifest.binaryPath] };
}

// The interpreter floor this CLI is published against. Must agree with
// `engines.node` in `clients/traycer-cli/package.json`; npm enforces that
// field at INSTALL time, which says nothing about the interpreter a service
// definition written later will name.
const MIN_NODE_VERSION: readonly [number, number, number] = [20, 18, 1];

// First `node` on PATH that is actually usable as this CLI's interpreter.
//
// Deliberately reads the variable rather than shelling out to `which` /
// `where`: spawning a shell during service registration is a far larger
// surface than the lookup it would perform, and inherits whatever rc files
// that shell sources.
//
// "Usable" means a regular file that runs AND reports a supported version.
// Being executable is not enough - the registration this feeds is long-lived
// and nothing rewrites it, so picking the wrong `node` here converts a
// working install into a service that dies at every start. That is a real
// configuration rather than a contrived one: an nvm or asdf user installs
// under Node 22 while `/usr/bin/node` 18 sits earlier on the SERVICE
// manager's PATH, and this walk would otherwise pin the 18.
async function resolveNodeOnPath(): Promise<string | null> {
  const rawPath = process.env.PATH;
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const entry of rawPath.split(delimiter)) {
    if (entry.length === 0) continue;
    for (const name of names) {
      const candidate = resolve(entry, name);
      // `access(X_OK)` alone is not enough: execute permission on a
      // DIRECTORY means "searchable", so a PATH entry holding a directory
      // called `node` would satisfy it and be returned ahead of the entry
      // holding the real interpreter - registering a directory as the
      // service's command. On Windows the check degrades to existence, so
      // the same applies there for any `node` file that is not a program.
      // Require a regular file as well, and keep walking otherwise.
      try {
        const candidateStat = await stat(candidate);
        if (!candidateStat.isFile()) continue;
        await access(candidate, constants.X_OK);
      } catch {
        continue;
      }
      if (await nodeMeetsMinimum(candidate)) return candidate;
    }
  }
  return null;
}

// Whether this `node` reports a version at or above `MIN_NODE_VERSION`.
//
// Unlike the slot's execute probe, an inconclusive answer here is a NO:
// there the question was "can the supervisor run this at all", where guessing
// yes preserves a working registration, while here it is "is this the right
// interpreter", where guessing yes bakes an unusable one into a unit file and
// the walk still has other candidates to try.
async function nodeMeetsMinimum(candidate: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(candidate, ["--version"], {
      timeout: SLOT_EXEC_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = parseNodeVersion(stdout);
    return parsed !== null && atLeastMinimum(parsed);
  } catch {
    return false;
  }
}

// `node --version` prints `v22.11.0`. Prerelease and build suffixes are
// ignored: a `v21.0.0-nightly` is treated as its 21.0.0 release, which is the
// right call for a floor check.
function parseNodeVersion(
  stdout: string,
): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeastMinimum(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const found = version[index] ?? 0;
    const required = MIN_NODE_VERSION[index] ?? 0;
    if (found !== required) return found > required;
  }
  return true;
}
