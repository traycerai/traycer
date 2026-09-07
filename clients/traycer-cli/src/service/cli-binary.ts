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

// Resolve the stable per-user CLI binary OS service manifests exec. Never copy an npm interpreter script into the slot.

export interface CliInvocation {
  // Absolute path to the executable the OS service should run.
  readonly command: string;
  // Leading arguments inserted before `host start ...` - typically
  // empty for a SEA binary, or `[<entry-source>]` for the dev tsx shim.
  readonly args: readonly string[];
}

export interface ResolveCliInvocationOptions {
  readonly environment: Environment;
  // Caller-supplied override.
  // Kept as a parameter on the function signature but no longer surfaced as a CLI flag - the well-known bin-dir convention below has subsumed every legitimate caller.
  readonly override: string | null;
  // When true and no manifest / bin-dir binary is found, allow an INTERPRETER run (tsx dev, smoke tests) to register the currently running process (`process.execPath` plus the entry script).
  // A packaged (SEA) binary never needs this flag: self-invocation is always safe for it, so npm/brew/hand-placed installs register without ever staging `~/.traycer` first.
  readonly allowSelfInvocation: boolean;
}

// Every caller below is asking one question: is there something at this path that can be REGISTERED as a service command (or copied into the slot to become one)?
// `access()` cannot answer it - it succeeds for a directory, and a directory is exactly what the slot degrades to when a botched install or a hand-rolled `mkdir ~/.traycer/bin/traycer` gets there first.
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
    // An interpreter distribution (npm) ships a script, not an executable, so it must never be copied into the slot - see `isInterpreterDistribution`, the single place that rule lives.
    // It keeps the direct-path registration, with the interpreter pinned when we can see it.
    if (isInterpreterDistribution(manifest.source)) {
      const interpreted = await npmInterpreterInvocation(manifest);
      if (interpreted !== null) return interpreted;
      // No conforming interpreter on THIS process's PATH.
      // What that proves differs by platform, and the response must too.
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

  // Self-invocation for a packaged binary: the running binary IS the whole program, so the service gets `<slot> host start` with no leading args.
  // A packaged binary's `process.argv[1]` is the raw invocation spelling (`traycer`, `./traycer`, an absolute path) - never an entry script - so the interpreter walk below would emit `<execPath> traycer host start` and every launch would die on `error: unknown command 'traycer'`.
  if (packaged) {
    return stagedSlotInvocation(opts.environment, process.execPath);
  }

  // Interpreter run with a slot already staged - the dev orchestrator's wrapper-script handoff.
  // Left as a direct reference: a dev wrapper is not ours to copy over itself.
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

  // Interpreter run (tsx dev, smoke tests): walking argv re-uses the same tsx-shebanged entry that's already on disk, so the supervisor command becomes `<node|bun> <entry> host start`.
  const command = process.execPath;
  const entryArg = process.argv[1];
  const args: readonly string[] =
    typeof entryArg === "string" ? [entryArg] : [];
  return { command, args };
}

// Stage `binaryPath` into the well-known slot and register that path. Copy, never symlink.
const execFileAsync = promisify(execFile);

const SLOT_EXEC_PROBE_TIMEOUT_MS = 10_000;

// Whether this path can actually be EXECUTED - answered by executing it, because nothing cheaper answers it.
// `access(X_OK)` does not: on Linux it reports the file's permission bits and succeeds on a `noexec` mount, so the refusal only ever appears at `execve`.
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
    // A copy that landed is not the same as a binary that runs, and the gap between those two has a real population: a hardened Linux install with `/home` mounted `noexec`.
    // The copy succeeds, the chmod succeeds, staging reports success - and the resulting unit dies at `ExecStart` with an execution error even though the package manager's own binary in `/usr/bin` was perfectly runnable.
    if (
      staged.staged === "already-well-known" ||
      (await canExecute(staged.wellKnownPath))
    ) {
      return { command: staged.wellKnownPath, args: [] };
    }
    // The slot will not run.
    // Demote ONLY if the source actually would, because the slot is otherwise still the better registration: it is the one path stable across upgrades, and trading it for a version-scoped path that ALSO cannot run gives up that stability for nothing.
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
  // A regular file, not merely a path that exists.
  // Staging fails when the slot has been replaced by a DIRECTORY (the rename cannot land on it), and that is precisely the case where an existence test would send the service definition to something no supervisor can execute.
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

// npm ships a Node bundle, not a SEA: the service unit must exec the interpreter with the script as argv.
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

// The interpreter floor this CLI is published against.
// Must agree with `engines.node` in `clients/traycer-cli/package.json`; npm enforces that field at INSTALL time, which says nothing about the interpreter a service definition written later will name.
const MIN_NODE_VERSION: readonly [number, number, number] = [20, 18, 1];

// First `node` on PATH that is actually usable as this CLI's interpreter.
// Deliberately reads the variable rather than shelling out to `which` / `where`: spawning a shell during service registration is a far larger surface than the lookup it would perform, and inherits whatever rc files that shell sources.
async function resolveNodeOnPath(): Promise<string | null> {
  const rawPath = process.env.PATH;
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const entry of rawPath.split(delimiter)) {
    if (entry.length === 0) continue;
    for (const name of names) {
      const candidate = resolve(entry, name);
      // `access(X_OK)` alone is not enough: execute permission on a DIRECTORY means "searchable", so a PATH entry holding a directory called `node` would satisfy it and be returned ahead of the entry holding the real interpreter - registering a directory as the service's command.
      // On Windows the check degrades to existence, so the same applies there for any `node` file that is not a program.
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
// Unlike the slot's execute probe, an inconclusive answer here is a NO: there the question was "can the supervisor run this at all", where guessing yes preserves a working registration, while here it is "is this the right interpreter", where guessing yes bakes an unusable one into a unit file and the walk still has other candidates to try.
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

// `node --version` prints `v22.11.0`.
// Prerelease and build suffixes are ignored: a `v21.0.0-nightly` is treated as its 21.0.0 release, which is the right call for a floor check.
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
