import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  openBootstrapLogFd,
  writeBootstrapMarker,
} from "../host/bootstrap-log";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import { withHostNodeOptions } from "../service/host-node-options";
import { hostHomeDir } from "../store/paths";
import {
  applyEnvOverrides,
  listEnvOverrides,
  type EnvOverrideValue,
} from "../store/config-store";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";

// `traycer host start` is the long-running supervisor invoked by the OS
// service manager (launchd, systemd-user, or Windows Scheduled Task). The
// slot is baked into the CLI build via `config.environment`; no slot flag
// is passed. It is the only place that translates the
// environment's `HostInstallRecord` into an actual `spawn()` of the
// installed host executable.
//
// Single launch path (no dev/prod conditional in runtime code):
//   1. Read ~/.traycer/host[/dev]/install/install.json.
//   2. Refuse to start when the record is missing or its executablePath
//      is empty / non-existent - emits stable machine-readable CLI
//      errors so Doctor / Desktop can recover.
//   3. Spawn `record.executablePath` directly. In production this is the
//      SEA host binary; in dev (`make dev-desktop`) the installer
//      stages a tiny wrapper script under `~/.traycer/host/dev/` that
//      internally exec's `node <bundle>` - the supervisor doesn't know
//      or care which it is.
//   4. Redirect stdout/stderr to the environment's host log so the
//      bootstrap markers and host output land in one cohesive file.
//   5. Forward SIGTERM / SIGINT / SIGHUP to the host child.
//   6. Exit with the host's final status (signal → 128+N, code → code).

export interface RunHostStartOptions {
  readonly environment: Environment;
  readonly cwd: string | null;
}

export interface HostStartTarget {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly record: HostInstallRecord;
}

export interface ResolveHostStartTargetDeps {
  readonly readInstallRecord: (
    environment: Environment,
  ) => Promise<HostInstallRecord | null>;
  readonly pathExists: (path: string) => Promise<boolean>;
}

const defaultDeps: ResolveHostStartTargetDeps = {
  readInstallRecord: readHostInstallRecord,
  pathExists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
};

// Pure helper - throws CliError for the three failure modes the
// supervisor must surface as stable codes:
//   - HOST_NOT_INSTALLED            (no install record for the environment)
//   - HOST_INSTALL_RECORD_INVALID   (record present but executablePath empty)
//   - HOST_NOT_INSTALLED            (record points at a file that doesn't exist)
//
// Tests exercise this directly; `runHostStart` calls it once on entry
// and converts a CliError throw into a `failed-to-spawn` marker +
// process.exit with the error's exit code.
export const defaultResolveHostStartTargetDeps: ResolveHostStartTargetDeps =
  defaultDeps;

export async function resolveHostStartTarget(
  opts: RunHostStartOptions,
  deps: ResolveHostStartTargetDeps,
): Promise<HostStartTarget> {
  const record = await deps.readInstallRecord(opts.environment);
  if (record === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `no host installed on environment '${opts.environment}'. Run 'traycer host install latest' to install one.`,
      details: { environment: opts.environment },
      exitCode: 69,
    });
  }
  if (record.executablePath.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record on environment '${opts.environment}' has an empty 'executablePath'`,
      details: { environment: opts.environment, version: record.version },
      exitCode: 1,
    });
  }
  if (!(await deps.pathExists(record.executablePath))) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `host executable missing on environment '${opts.environment}' at ${record.executablePath}. Re-run 'traycer host install latest'.`,
      details: {
        environment: opts.environment,
        executablePath: record.executablePath,
        version: record.version,
      },
      exitCode: 69,
    });
  }

  // Tell the host which slot to write its runtime files (pid.json) into,
  // resolved from THIS CLI build's environment. The CLI owns slot resolution
  // (it installed into this dir), so a host binary baked for a different slot -
  // notably a downloaded *production* host under `make dev-desktop` - still
  // publishes pid.json where this environment's desktop watches, instead of
  // self-resolving to its own baked slot. PATH-ONLY: this never selects the
  // host's cloud/auth target, which stays baked into the host binary.
  return {
    executable: record.executablePath,
    args: ["--host-data-dir", hostHomeDir(opts.environment)],
    cwd: opts.cwd ?? dirname(record.executablePath),
    record,
  };
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunHostStartDeps extends ResolveHostStartTargetDeps {
  readonly spawn: SpawnImpl;
  readonly openLogFd: (environment: Environment) => Promise<number>;
  readonly readEnvOverrides: () => Promise<Record<string, EnvOverrideValue>>;
  readonly writeMarker: typeof writeBootstrapMarker;
  // `process.exit` itself returns `never`, but the dependency is typed
  // `void` so test stubs can record the requested exit code without
  // throwing from inside event-handler callbacks. Real callers should
  // not depend on the function returning.
  readonly exit: (code: number) => void;
  readonly onError: (message: string) => void;
  readonly logger: ILogger | null;
}

const defaultRunDeps: RunHostStartDeps = {
  ...defaultDeps,
  spawn: (cmd, args, options) => nodeSpawn(cmd, args.slice(), options),
  openLogFd: openBootstrapLogFd,
  readEnvOverrides: async () => ({ ...(await listEnvOverrides()) }),
  writeMarker: writeBootstrapMarker,
  exit: (code) => {
    process.exit(code);
  },
  onError: (message) => {
    console.error(message);
  },
  logger: null,
};

// Long-running entrypoint invoked by the OS service manager. Resolves
// the spawn target, kicks off the child, and only returns when the
// process exits via `deps.exit(...)`. Dependency-injected so tests can
// exercise the resolve / signal / spawn-failure branches without
// touching the real filesystem or process.
export const defaultRunHostStartDeps: RunHostStartDeps = defaultRunDeps;

export async function runHostStart(
  opts: RunHostStartOptions,
  injected: Partial<RunHostStartDeps>,
): Promise<void> {
  const deps: RunHostStartDeps = { ...defaultRunDeps, ...injected };
  const logger = deps.logger ?? createCliLogger(opts.environment);

  logger.info("Host supervisor starting", {
    environment: opts.environment,
    hasCwdOverride: opts.cwd !== null,
  });

  let target: HostStartTarget;
  try {
    target = await resolveHostStartTarget(opts, deps);
  } catch (err) {
    if (err instanceof CliError) {
      logger.warn("Host supervisor target resolution failed", {
        environment: opts.environment,
        code: err.code,
        exitCode: err.exitCode,
      });
      const detailLine = JSON.stringify({
        code: err.code,
        message: err.message,
        details: err.details,
      });
      await deps.writeMarker(opts.environment, "failed-to-spawn", {
        shell: undefined,
        args: undefined,
        bundle: undefined,
        exitCode: undefined,
        signal: undefined,
        error: `${err.code}: ${err.message}`,
      });
      deps.onError(`traycer host start: ${err.code}: ${err.message}`);
      deps.onError(detailLine);
      return deps.exit(err.exitCode);
    }
    logger.error(
      "Host supervisor target resolution threw unexpectedly",
      { environment: opts.environment, exitCode: 1 },
      errorFromUnknown(err),
    );
    throw err;
  }

  logger.info("Host supervisor target resolved", {
    environment: opts.environment,
    version: target.record.version,
    argCount: target.args.length,
    hasCwdOverride: opts.cwd !== null,
  });

  const envOverrides = await deps.readEnvOverrides();
  logger.debug("Host supervisor loaded env overrides", {
    environment: opts.environment,
    overrideCount: Object.keys(envOverrides).length,
  });
  const env: NodeJS.ProcessEnv = {
    ...applyEnvOverrides(process.env, envOverrides),
    TERM_PROGRAM: "traycer",
  };
  // Cap the host's V8 young generation at creation time on EVERY platform.
  // This is the single cross-platform host launch path, so applying it here
  // gives Linux (systemd) and Windows (schtasks, which cannot set env vars in
  // its task XML) the same cap macOS gets from its LaunchAgent plist. The helper
  // dedups when the inherited env already carries it (the macOS plist case).
  env.NODE_OPTIONS = withHostNodeOptions(env.NODE_OPTIONS);
  // The host resolves its slot from its own `config.environment` (baked
  // per build) - the supervisor passes no environment arg or env. It also
  // computes its own CLI bin dir (`~/.traycer/cli[/<slot>]/bin`, where the
  // bundled `traycer` is symlinked) and puts it on PATH, so no `traycer` path
  // needs to be handed down here.

  await deps.writeMarker(opts.environment, "starting", {
    shell: undefined,
    args: target.args,
    bundle: target.executable,
    exitCode: undefined,
    signal: undefined,
    error: undefined,
  });

  const logFd = await deps.openLogFd(opts.environment);

  let child: ChildProcess;
  try {
    child = deps.spawn(target.executable, target.args, {
      cwd: target.cwd,
      env,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error(
      "Host supervisor spawn failed",
      { environment: opts.environment, exitCode: 66 },
      errorFromUnknown(cause),
    );
    await deps.writeMarker(opts.environment, "failed-to-spawn", {
      shell: undefined,
      args: undefined,
      bundle: target.executable,
      exitCode: undefined,
      signal: undefined,
      error: message,
    });
    deps.onError(
      `traycer host start: ${CLI_ERROR_CODES.HOST_SPAWN_FAILED}: ${message}`,
    );
    return deps.exit(66);
  }

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      logger.debug("Host supervisor forwarding signal to child", {
        environment: opts.environment,
        signal: sig,
        childPidKnown: child.pid !== undefined,
      });
      if (child.pid !== undefined) {
        try {
          child.kill(sig);
        } catch (cause) {
          logger.warn("Host supervisor failed to forward signal", {
            environment: opts.environment,
            signal: sig,
            errorName: errorFromUnknown(cause).name,
            errorMessage: errorFromUnknown(cause).message,
          });
          // Child may have already exited.
        }
      }
    });
  }

  child.on("exit", (code, signal) => {
    // Marker writes are fire-and-forget here - the listener can't await
    // and the process is about to exit anyway; the OS flushes the log
    // append on close.
    if (signal !== null) {
      logger.warn("Host child exited by signal", {
        environment: opts.environment,
        signal,
        exitCode: 128 + signalNumber(signal),
      });
      void deps.writeMarker(opts.environment, "killed", {
        shell: undefined,
        args: undefined,
        bundle: target.executable,
        exitCode: undefined,
        signal,
        error: undefined,
      });
      return deps.exit(128 + signalNumber(signal));
    }
    if (code === null || code === 0) {
      logger.info("Host child exited cleanly", {
        environment: opts.environment,
        exitCode: code ?? 0,
      });
      void deps.writeMarker(opts.environment, "exited", {
        shell: undefined,
        args: undefined,
        bundle: target.executable,
        exitCode: code,
        signal: undefined,
        error: undefined,
      });
      return deps.exit(code ?? 0);
    }
    logger.error(
      "Host child exited with non-zero status",
      {
        environment: opts.environment,
        exitCode: code,
      },
      null,
    );
    void deps.writeMarker(opts.environment, "crashed", {
      shell: undefined,
      args: undefined,
      bundle: target.executable,
      exitCode: code,
      signal: undefined,
      error: undefined,
    });
    return deps.exit(code);
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 2;
  if (signal === "SIGTERM") return 15;
  if (signal === "SIGHUP") return 1;
  if (signal === "SIGKILL") return 9;
  return 15;
}
