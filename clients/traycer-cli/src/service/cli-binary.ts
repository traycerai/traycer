import { access } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { readCliManifest } from "../manifest/cli-manifest";
import {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveServiceCliInvocation(
  opts: ResolveCliInvocationOptions,
): Promise<CliInvocation> {
  if (opts.override !== null) {
    if (!(await pathExists(opts.override))) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
        message: `service install: override path does not exist: ${opts.override}`,
        details: { override: opts.override },
        exitCode: 1,
      });
    }
    return { command: opts.override, args: [] };
  }

  const manifest = await readCliManifest(opts.environment);
  if (manifest !== null) {
    if (!(await pathExists(manifest.binaryPath))) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
        message: `service install: CLI manifest binaryPath does not exist: ${manifest.binaryPath}`,
        details: {
          binaryPath: manifest.binaryPath,
          environment: opts.environment,
        },
        exitCode: 1,
      });
    }
    // npm ships a script, not an executable: it must never be copied into
    // the slot (the host would exec a `.exe` full of JavaScript on Windows,
    // and a shebang that outlives its interpreter on POSIX). It keeps the
    // direct-path registration, with the interpreter pinned when we can see
    // it. Superseded once npm ships per-platform SEA binaries, at which
    // point npm becomes an ordinary executable install and falls through to
    // the staging below with everything else.
    if (manifest.source === "npm") {
      return (
        (await npmInterpreterInvocation(manifest)) ?? {
          command: manifest.binaryPath,
          args: [],
        }
      );
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
  if (await pathExists(conventionalBinary)) {
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
// the same stable path. Staging is best-effort: on failure the service is
// still registered against the real binary and keeps working - only the
// host's view through the slot stays cold, which is strictly what it was
// before this call.
async function stagedSlotInvocation(
  environment: Environment,
  binaryPath: string,
): Promise<CliInvocation> {
  const staged = await stageWellKnownCliBinary({ environment, binaryPath });
  return {
    command: staged.staged === "failed" ? binaryPath : staged.wellKnownPath,
    args: [],
  };
}

// The npm distribution ships a Node bundle, not a SEA: its manifest
// (usually SYNTHESIZED by `readCliManifest` from the bundle's
// `TRAYCER_CLI_DISTRIBUTION="npm"` shim, since the npm package has no
// install hook) points at the shebanged bundle script. Registering that
// script directly makes the service depend on `node` being on the service
// manager's PATH - false for nvm installs under systemd, so the unit dies
// with ENOENT while the CLI works fine interactively. When the resolving
// process IS that bundle (the shim env is set and we are not a packaged
// binary, so `process.execPath` is the interpreter running it), pin the
// absolute interpreter into the invocation instead:
// `<node> <bundle> host start`. Resolutions from OTHER processes cannot
// know the right interpreter and keep the direct-script behavior.
// Superseded once npm ships per-platform SEA binaries.
async function npmInterpreterInvocation(manifest: {
  readonly binaryPath: string;
  readonly source: string;
}): Promise<CliInvocation | null> {
  if (manifest.source !== "npm") return null;
  if (process.env.TRAYCER_CLI_DISTRIBUTION !== "npm") return null;
  if (await isPackagedRun()) return null;
  return { command: process.execPath, args: [manifest.binaryPath] };
}

// Whether this process is a compiled single-executable (SEA) binary, i.e.
// the program IS `process.execPath` with no entry script. `node:sea` is
// absent under some interpreters (bun), where the answer is "no" anyway.
async function isPackagedRun(): Promise<boolean> {
  try {
    const { isSea } = await import("node:sea");
    return isSea();
  } catch {
    return false;
  }
}
