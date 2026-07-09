import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { readCliManifest } from "../manifest/cli-manifest";
import { cliInstallHomeDir } from "../store/paths";

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
//      Lets the orchestrator hand off to the CLI without any
//      explicit flag or env-var coupling - convention over
//      configuration.
//   3. Self-invocation: `process.execPath` + first argv entry. Opt-in
//      via `allowSelfInvocation`; used when the running CLI binary
//      itself is the right thing to point launchd at (brew /
//      manual install with no manifest yet, NP-2 dev smoke testing).
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
  // When true and no manifest / bin-dir binary is found, fall back
  // to invoking the currently-running process (`process.execPath`
  // plus the entry script). Used by package-manager-installed CLIs
  // (brew, manual) where the running binary IS the right thing to
  // register.
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

  if (!opts.allowSelfInvocation) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
      message: `service install: no CLI manifest at <cliHomeDir>/manifest.json and no binary at ${conventionalBinary}; stage a CLI binary at the well-known location or run from a packaged CLI`,
      details: { environment: opts.environment, conventionalBinary },
      exitCode: 1,
    });
  }

  // Self-invocation fallback: register the service against the
  // running process. On POSIX the supervisor command becomes
  // `<execPath> <argv[1]> host start`, which works
  // regardless of whether we're invoked via `node`, `bun`, or a SEA
  // binary. Walking argv lets dev / smoke-test invocations re-use
  // the same tsx-shebanged entry that's already on disk.
  const command = process.execPath;
  const entryArg = process.argv[1];
  const args: readonly string[] =
    typeof entryArg === "string" ? [entryArg] : [];
  return { command, args };
}

function wellKnownCliBinaryPath(environment: Environment): string {
  // Mirrors what Desktop's `cliBinDir()` / `cliBinaryName()` helpers and the
  // dev orchestrator's per-run `cliBinDir` (scripts/dev-desktop.js,
  // `buildDevDesktopRunPaths`) agree on. Windows uses `.exe` for SEA
  // binaries; `.cmd` wrappers (dev orchestrator on Windows) are NOT included
  // here - Windows service registration goes through Scheduled Tasks via
  // `windows.ts`, which has its own convention.
  const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
  return join(cliInstallHomeDir(environment), "bin", binaryName);
}
