import { access } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { readCliManifest } from "../manifest/cli-manifest";
import {
  stageWellKnownCliBinary,
  wellKnownCliBinaryPath,
} from "../store/well-known-cli";

// Resolve the stable per-user CLI binary that OS service manifests
// should invoke. Discovery order:
//
//   1. CLI manifest at `<cliInstallHomeDir>/manifest.json` - written by the
//      Desktop bootstrap + package-manager install hooks. Source of
//      truth when present.
//   2. Install-scoped bin dir at `<cliInstallHomeDir>/bin/traycer` - the
//      well-known staging location every install path drops a binary
//      (or wrapper script) into BEFORE invoking `traycer host
//      install`. Used by:
//        - Desktop's setup splash (stages bundled CLI at
//          `~/.traycer/cli/bin/traycer` before host-bootstrap)
//        - The dev orchestrator (`scripts/dev-desktop.js` stages a
//          bun wrapper at `~/.traycer/cli/dev-runs/<slot>/bin/traycer`
//          when `DEV_DESKTOP_SLOT` is present)
//        - `cli mark-source` / `cli re-anchor` (stage a copy of the
//          anchored binary alongside the manifest write)
//      Lets the orchestrator hand off to the CLI without any
//      explicit flag or env-var coupling - convention over
//      configuration.
//   3. Self-invocation: the running binary itself is the right thing to
//      point the supervisor at. Always available to a PACKAGED (SEA)
//      binary - npm/brew/hand-placed installs with no manifest yet -
//      which also stages the well-known slot so the host daemon (whose
//      own CLI discovery reads ONLY that slot) can shell this CLI.
//      Interpreter runs (tsx dev, smoke tests) must opt in via
//      `allowSelfInvocation`.
//
// Steps 1 and 2 always run; (3) is the final fallback.

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
    return { command: manifest.binaryPath, args: [] };
  }

  // Well-known per-environment bin dir. Every install path (Desktop setup
  // splash, dev orchestrator) drops a binary or wrapper script here
  // before invoking the CLI's host install, so it's the canonical
  // "registered installer" location even when no manifest has been
  // written yet.
  const conventionalBinary = wellKnownCliBinaryPath(opts.environment);
  if (await pathExists(conventionalBinary)) {
    return { command: conventionalBinary, args: [] };
  }

  const packaged = await isPackagedRun();
  if (!packaged && !opts.allowSelfInvocation) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
      message: `service install: no CLI manifest at <cliHomeDir>/manifest.json and no binary at ${conventionalBinary}; stage a CLI binary at the well-known location, run from a packaged CLI, or pass --allow-self-invocation for an interpreter-run dev CLI`,
      details: { environment: opts.environment, conventionalBinary },
      exitCode: 1,
    });
  }

  // Self-invocation fallback: register the service against the running
  // process.
  //
  // A PACKAGED (SEA) binary's `process.argv[1]` is the raw invocation
  // spelling (`traycer`, `./traycer`, an absolute path) - never an entry
  // script - so re-invoking `<execPath> <argv[1]>` produces
  // `error: unknown command`. The binary itself is the whole program:
  // register `<execPath>` with no leading args. Stage the well-known slot
  // at the same time so the host daemon (whose CLI discovery reads ONLY
  // `<cliInstallHomeDir>/bin/traycer`) can shell this CLI for doctor /
  // update, and point the service at that slot when staging succeeds - a
  // later `cli re-anchor` then refreshes what the service runs without
  // re-registration. Staging failure degrades to the real binary path:
  // the service still works, only the host's slot view stays cold.
  if (packaged) {
    const staged = await stageWellKnownCliBinary({
      environment: opts.environment,
      binaryPath: process.execPath,
    });
    return {
      command:
        staged.staged === "failed" ? process.execPath : staged.wellKnownPath,
      args: [],
    };
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
