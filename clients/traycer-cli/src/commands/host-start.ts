import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  openBootstrapLogFd,
  writeBootstrapMarker,
  writeBootstrapTerminalMarker,
  type BootstrapMarkerFields,
  type BootstrapPhase,
} from "../host/bootstrap-log";
import { rotateHostLogIfOversized } from "../host/host-log-rotation";
import {
  findLiveIncumbentHost,
  type IncumbentHost,
} from "../host/incumbent-check";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import { withHostNodeOptions } from "../service/host-node-options";
import { hostHomeDir } from "../store/paths";
import {
  attestLaunchdSupervisorPid,
  readLayer0Frame,
  readLiveProbeContext,
  readLiveProbeContextForServiceLabel,
  writeProbeMarkerAtomically,
  type Layer0FrameRead,
  type LiveProbeContext,
  type LiveProbeContextRead,
} from "../host/lifecycle-probe";
import {
  mapLayer0FrameToProbeOutcome,
  type ProbeMarker,
  type ProbeSupervisorAttestation,
} from "@traycer-clients/shared/host-lifecycle";
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

export type HostStartProbeOptions = {
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly serviceLabel: string;
};

/** Existing service invocations stay label-less until their plist is refreshed. */
export type RunHostStartOptions =
  | {
      readonly environment: Environment;
      readonly cwd: string | null;
    }
  | {
      readonly environment: Environment;
      readonly cwd: string | null;
      /** Identity binding for an ordinary service start; no probe authority. */
      readonly serviceLabel: string;
    }
  | {
      readonly environment: Environment;
      readonly cwd: string | null;
      /** Present only for a journal-authorised reclaim spawn probe. */
      readonly probe: HostStartProbeOptions;
    };

export interface HostStartTarget {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly record: HostInstallRecord;
}

/**
 * Child descriptor carrying the framed Layer-0 status record, named to the
 * host by `--layer0-status-fd`. Three is the first descriptor past
 * stdin/stdout/stderr and is the normal protocol; the flag exists so the host
 * never has to infer the transport from the descriptor's type.
 */
export const LAYER0_STATUS_FD = 3;

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
  // The host home dir, NOT the executable's own directory: on Windows a
  // process's CWD is an open handle on that directory, and children the
  // host spawns without an explicit cwd inherit it. With the CWD inside
  // `install/`, any such child that outlives the pre-update kill blocks
  // the install-dir swap rename with EBUSY - and the slot scan cannot see
  // a process whose only tie to the install is its CWD. The host itself
  // resolves nothing cwd-relative (SEA module loads anchor at
  // `import.meta.url`; data paths come from `--host-data-dir`).
  return {
    executable: record.executablePath,
    args: ["--host-data-dir", hostHomeDir(opts.environment)],
    cwd: opts.cwd ?? hostHomeDir(opts.environment),
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
  // Injected so tests can drive the "another host already owns this data
  // dir" branch without a real pid.json or a live loopback listener.
  readonly findIncumbentHost: (
    environment: Environment | undefined,
  ) => Promise<IncumbentHost | null>;
  readonly openLogFd: (environment: Environment) => Promise<number>;
  readonly rotateLog: (
    environment: Environment,
  ) => Promise<"rotated" | "skipped">;
  readonly readEnvOverrides: () => Promise<Record<string, EnvOverrideValue>>;
  readonly writeMarker: typeof writeBootstrapMarker;
  readonly writeTerminalMarker: typeof writeBootstrapTerminalMarker;
  // `process.exit` itself returns `never`, but the dependency is typed
  // `void` so test stubs can record the requested exit code without
  // throwing from inside event-handler callbacks. Real callers should
  // not depend on the function returning.
  readonly exit: (code: number) => void;
  readonly onError: (message: string) => void;
  readonly logger: ILogger | null;
  readonly readLiveProbeContext: (
    environment: Environment,
    input: LiveProbeContext,
    now: string,
  ) => Promise<LiveProbeContextRead>;
  readonly readLiveProbeContextForServiceLabel: (
    environment: Environment,
    serviceLabel: string,
    now: string,
  ) => Promise<LiveProbeContextRead>;
  readonly now: () => string;
  readonly readLayer0Frame: (
    stream: Readable,
    timeoutMs: number,
  ) => Promise<Layer0FrameRead>;
  readonly attestProbeSupervisor: (
    serviceLabel: string,
    supervisorPid: number,
  ) => Promise<ProbeSupervisorAttestation | null>;
  readonly writeProbeMarker: (
    environment: Environment,
    marker: ProbeMarker,
  ) => Promise<void>;
}

const defaultRunDeps: RunHostStartDeps = {
  ...defaultDeps,
  spawn: (cmd, args, options) => nodeSpawn(cmd, args.slice(), options),
  findIncumbentHost: findLiveIncumbentHost,
  openLogFd: openBootstrapLogFd,
  rotateLog: rotateHostLogIfOversized,
  readEnvOverrides: async () => ({ ...(await listEnvOverrides()) }),
  writeMarker: writeBootstrapMarker,
  writeTerminalMarker: writeBootstrapTerminalMarker,
  exit: (code) => {
    process.exit(code);
  },
  onError: (message) => {
    console.error(message);
  },
  logger: null,
  readLiveProbeContext,
  readLiveProbeContextForServiceLabel,
  now: () => new Date().toISOString(),
  readLayer0Frame,
  attestProbeSupervisor: attestLaunchdSupervisorPid,
  writeProbeMarker: writeProbeMarkerAtomically,
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
  // One attempt id for every marker this supervisor invocation writes so
  // readers can correlate starting → terminal pairs without relying only
  // on a pre-action log baseline (Finding F evidence identity).
  const attemptId = randomUUID();
  const supervisorPid = process.pid;
  const requestedProbe = "probe" in opts ? opts.probe : null;
  const serviceLabel = "serviceLabel" in opts ? opts.serviceLabel : null;
  const probeRead: LiveProbeContextRead | null =
    requestedProbe !== null
      ? await deps.readLiveProbeContext(
          opts.environment,
          requestedProbe,
          deps.now(),
        )
      : serviceLabel === null
        ? null
        : await deps.readLiveProbeContextForServiceLabel(
            opts.environment,
            serviceLabel,
            deps.now(),
          );
  const probeContext =
    probeRead !== null && probeRead.kind === "authorised"
      ? probeRead.context
      : null;

  logger.info("Host supervisor starting", {
    environment: opts.environment,
    hasCwdOverride: opts.cwd !== null,
    attemptId,
    supervisorPid,
    probe: probeContext !== null,
    // Carried so a machine that never enters probe mode says WHY. All three
    // non-authorised arms are equally safe (no incumbent bypass), but a
    // journal at a schema version this build cannot read is a very different
    // situation from one whose deadline elapsed, and neither is "no journal".
    probeAuthority:
      probeRead === null
        ? "not-requested"
        : probeRead.kind === "authorised"
          ? "authorised"
          : probeRead.kind === "unauthorised"
            ? probeRead.reason
            : `indeterminate: ${probeRead.cause}`,
  });

  // A stale/malformed probe invocation has no authority to bypass the normal
  // incumbent guard. Exit cleanly without a marker so the reconciler treats it
  // as ambiguity, never as wedge evidence or permission to evict raw.
  if (requestedProbe !== null && probeContext === null) {
    logger.warn("Host probe declined: no matching live transition journal", {
      environment: opts.environment,
      transitionId: requestedProbe.transitionId,
      serviceLabel: requestedProbe.serviceLabel,
      attemptId,
      supervisorPid,
    });
    return deps.exit(0);
  }

  // Best-effort backstop against stacking a second host on a live one.
  // BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT COVER.
  //
  // Runs BEFORE `resolveHostStartTarget` on purpose. Another host already
  // owning this data dir settles what this invocation should do regardless
  // of whether THIS label can resolve its own install target, and the two
  // exit codes disagree: a resolution failure exits 69 / 1, which
  // `KeepAlive.SuccessfulExit = false` treats as restartable, so launchd
  // relaunches this job into a throttled crash loop while a perfectly
  // healthy host is serving. Probing first turns that into a quiet exit 0.
  // The record can be missing or invalid while a host is live - an
  // uninstall, a failed install, or the window where `host install` has
  // swapped `install/` aside - so this is reachable, not theoretical. With
  // no incumbent the resolution error still surfaces exactly as before.
  //
  // Covered (deterministic): any STAGGERED start where a host is already
  // publishing - a raw `traycer host start` against a running host, one
  // launchd label starting while the other's host is up, a crash-restart of
  // one label mid-session. That is the shape of the field bug: an install
  // bootstrapping the CLI label beside Desktop's already-running agent.
  //
  // NOT covered: two supervisors starting SIMULTANEOUSLY, which is what a
  // cold login does when a machine carries both the CLI label
  // (`ai.traycer.host`) and Desktop's SMAppService label
  // (`ai.traycer.host.agent`), since both set `RunAtLoad`. pid.json does not
  // exist yet - the host unlinks it on graceful shutdown and publishes only
  // after `listen()` succeeds - so both callers observe no incumbent and
  // both spawn. This check is a read-only observation with no reservation
  // behind it; it cannot serialise that. The host binds an ephemeral port
  // (`listenPort: 0`), so there is no OS-level collision to fall back on
  // either.
  //
  // That residual is contained elsewhere, not here: `installService`'s
  // ownership refusals stop a dual registration from being CREATED at all,
  // and Desktop's `retireLegacyLabelRegistrations` deletes the legacy plist
  // and boots out the stale label - killing a duplicate mid-session, not
  // only at next login. Real mutual exclusion belongs in the host process
  // as a single-instance lock held for its lifetime, which is tracked
  // separately.
  //
  // Declining is the whole policy: never evict the incumbent. Intentional
  // version replacement belongs to the install lifecycle (`beforeSwap`
  // stops the running host before the swap), which knows it is an upgrade;
  // this supervisor cannot tell an upgrade from an accidental second job.
  // Evicting would also flap against KeepAlive - a signal-killed supervisor
  // exits 128+N, which `SuccessfulExit: false` treats as restartable, so
  // the victim comes back and evicts us in turn.
  //
  // Exit 0 specifically: `KeepAlive.SuccessfulExit = false` leaves a
  // cleanly-exited job down until the next login instead of relaunching it
  // in a loop. No bootstrap marker is written - declining is not a spawn
  // attempt, and the existing phases all describe one.
  const incumbent =
    probeContext === null
      ? await deps.findIncumbentHost(opts.environment)
      : null;
  if (incumbent !== null) {
    logger.warn(
      "Host supervisor declined to start - another host already owns this data dir",
      {
        environment: opts.environment,
        incumbentPid: incumbent.pid,
        incumbentVersion: incumbent.version,
        incumbentWebsocketUrl: incumbent.websocketUrl,
        attemptId,
        supervisorPid,
      },
    );
    return deps.exit(0);
  }

  let target: HostStartTarget;
  try {
    target = await resolveHostStartTarget(opts, deps);
  } catch (err) {
    if (err instanceof CliError) {
      logger.warn("Host supervisor target resolution failed", {
        environment: opts.environment,
        code: err.code,
        exitCode: err.exitCode,
        attemptId,
      });
      const detailLine = JSON.stringify({
        code: err.code,
        message: err.message,
        details: err.details,
      });
      await deps.writeMarker(
        opts.environment,
        "failed-to-spawn",
        markerFields(attemptId, supervisorPid, {
          shell: undefined,
          args: undefined,
          bundle: undefined,
          exitCode: undefined,
          signal: undefined,
          error: `${err.code}: ${err.message}`,
        }),
      );
      await writeProbeTerminalIfAttested({
        context: probeContext,
        attemptId,
        supervisorPid,
        reason: `target-resolution-${err.code}`,
        deps,
        environment: opts.environment,
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
    await writeProbeTerminalIfAttested({
      context: probeContext,
      attemptId,
      supervisorPid,
      reason: "target-resolution-unexpected",
      deps,
      environment: opts.environment,
    });
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

  // Bound the log before anything appends to this run. Nothing truncates
  // `host.log` - every writer appends - so a start is the only safe moment to
  // roll it: the fd opened below lives for the child's whole lifetime and would
  // follow the file across a rename, splitting one session across two files.
  // Under the cap this is a no-op, so consecutive starts still share one log.
  const rotation = await deps.rotateLog(opts.environment);
  logger.debug("Host supervisor checked log rotation", {
    environment: opts.environment,
    rotation,
  });

  await deps.writeMarker(
    opts.environment,
    "starting",
    markerFields(attemptId, supervisorPid, {
      shell: undefined,
      args: target.args,
      bundle: target.executable,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
    }),
  );

  const logFd = await deps.openLogFd(opts.environment);
  // `--layer0-status-fd` is the AUTHORIZATION for the framed Layer-0 status
  // transport, not a hint about it: the host writes a status frame only when
  // this supervisor names the descriptor, and is a hard no-op otherwise. It
  // is therefore passed if and only if the `stdio` vector below actually
  // opens the pipe (probe mode). Passing it speculatively would re-create the
  // defect it exists to close - the host used to sniff fd 3's type, and
  // Node's own IPC channel is a Unix-domain socket on fd 3, so unrelated IPC
  // received raw frames. Version skew is safe both ways: an N-1 host scans
  // argv and ignores the unknown flag, and a current host that is not given
  // the flag simply writes nothing.
  const hostArgs = [
    ...target.args,
    "--layer0-attempt-id",
    attemptId,
    ...(probeContext === null
      ? []
      : ["--layer0-status-fd", String(LAYER0_STATUS_FD)]),
  ] as const;

  // The `make dev-desktop` host runtime is a `.cmd` wrapper that execs
  // `node <bundle>` (production is a real `.exe`). bun/Node launch a `.cmd`
  // through cmd.exe but do NOT quote a wrapper path containing spaces (e.g.
  // "C:\Users\Traycer Dev\..."), so cmd splits it and fails with
  // "'C:\Users\Traycer' is not recognized". Invoke cmd.exe ourselves with a
  // verbatim, fully-quoted command line on Windows; every other case spawns
  // the executable directly.
  const launch = resolveSpawnInvocation(target.executable, hostArgs);

  let child: ChildProcess;
  try {
    child = deps.spawn(launch.command, launch.args, {
      cwd: target.cwd,
      env,
      // Index LAYER0_STATUS_FD of this vector IS the descriptor named by
      // `--layer0-status-fd` above; the two must not drift apart.
      stdio:
        probeContext === null
          ? ["ignore", logFd, logFd]
          : ["ignore", logFd, logFd, "pipe"],
      windowsHide: process.platform === "win32",
      ...(launch.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error(
      "Host supervisor spawn failed",
      { environment: opts.environment, exitCode: 66 },
      errorFromUnknown(cause),
    );
    await deps.writeMarker(
      opts.environment,
      "failed-to-spawn",
      markerFields(attemptId, supervisorPid, {
        shell: undefined,
        args: undefined,
        bundle: target.executable,
        exitCode: undefined,
        signal: undefined,
        error: message,
      }),
    );
    await writeProbeTerminalIfAttested({
      context: probeContext,
      attemptId,
      supervisorPid,
      reason: "host-spawn-failed",
      deps,
      environment: opts.environment,
    });
    deps.onError(
      `traycer host start: ${CLI_ERROR_CODES.HOST_SPAWN_FAILED}: ${message}`,
    );
    return deps.exit(66);
  }

  const probeObservation =
    probeContext === null
      ? null
      : observeProbeStatus({
          child,
          context: probeContext,
          attemptId,
          supervisorPid,
          deps,
          environment: opts.environment,
        });
  // `persistChildExit` awaits this inside a try/catch, but ONLY on the `exit`
  // path. If the child fails asynchronously (`child.once("error", …)`, e.g.
  // ENOENT) or simply never exits, nothing is ever attached - so a rejected
  // `writeProbeMarker` (disk full, EACCES on the marker path) surfaces as an
  // unhandled rejection and can take the supervisor down. Killing the
  // supervisor because a diagnostic marker could not be written is a strictly
  // worse outcome than not writing it.
  //
  // Marking it handled here rather than replacing the promise: `.catch()`
  // returns a NEW promise and leaves `probeObservation` itself rejected but
  // acknowledged, so `persistChildExit` still observes the failure and still
  // logs it with its own context. Swallowing it into a resolved
  // `{ marker: null }` would trade the crash for silence.
  void probeObservation?.catch(() => undefined);

  // `spawn()` may report a failure asynchronously (notably ENOENT on some
  // platforms).  It is an EventEmitter error, not an exception from spawn,
  // so it needs the same terminal evidence path as a synchronous failure.
  // Guard both listeners: some child implementations subsequently emit exit.
  let childFinalized = false;
  const finalizeChildExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (childFinalized) return;
    childFinalized = true;
    void persistChildExit({
      code,
      signal,
      deps,
      logger,
      environment: opts.environment,
      attemptId,
      supervisorPid,
      bundle: target.executable,
      probeObservation,
    });
  };
  const finalizeChildSpawnError = (cause: Error): void => {
    if (childFinalized) return;
    childFinalized = true;
    void persistAsyncChildSpawnFailure({
      cause,
      deps,
      logger,
      environment: opts.environment,
      attemptId,
      supervisorPid,
      bundle: target.executable,
      probeContext,
    });
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      logger.debug("Host supervisor forwarding signal to child", {
        environment: opts.environment,
        signal: sig,
        childPidKnown: child.pid !== undefined,
        attemptId,
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

  child.once("error", finalizeChildSpawnError);
  child.once("exit", finalizeChildExit);
}

async function persistAsyncChildSpawnFailure(input: {
  readonly cause: Error;
  readonly deps: RunHostStartDeps;
  readonly logger: ILogger;
  readonly environment: Environment;
  readonly attemptId: string;
  readonly supervisorPid: number;
  readonly bundle: string;
  readonly probeContext: LiveProbeContext | null;
}): Promise<void> {
  const message = input.cause.message;
  input.logger.error(
    "Host supervisor asynchronous spawn failed",
    { environment: input.environment, exitCode: 66 },
    errorFromUnknown(input.cause),
  );
  await input.deps.writeMarker(
    input.environment,
    "failed-to-spawn",
    markerFields(input.attemptId, input.supervisorPid, {
      shell: undefined,
      args: undefined,
      bundle: input.bundle,
      exitCode: undefined,
      signal: undefined,
      error: message,
    }),
  );
  await writeProbeTerminalIfAttested({
    context: input.probeContext,
    attemptId: input.attemptId,
    supervisorPid: input.supervisorPid,
    reason: "host-spawn-failed",
    deps: input.deps,
    environment: input.environment,
  });
  input.deps.onError(
    `traycer host start: ${CLI_ERROR_CODES.HOST_SPAWN_FAILED}: ${message}`,
  );
  input.deps.exit(66);
}

async function persistChildExit(input: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly deps: RunHostStartDeps;
  readonly logger: ILogger;
  readonly environment: Environment;
  readonly attemptId: string;
  readonly supervisorPid: number;
  readonly bundle: string;
  readonly probeObservation: Promise<ProbeObservation> | null;
}): Promise<void> {
  if (input.probeObservation !== null) {
    try {
      const observation = await input.probeObservation;
      if (
        observation.marker !== null &&
        observation.marker.outcome.kind === "awaiting-readiness"
      ) {
        await input.deps.writeProbeMarker(input.environment, {
          ...observation.marker,
          outcome: {
            kind: "terminal",
            reason:
              input.signal === null
                ? `child-exit-${input.code ?? 0}`
                : `child-signal-${input.signal}`,
          },
        });
      }
    } catch (error) {
      input.logger.warn("Host probe marker finalization failed", {
        environment: input.environment,
        errorName: errorFromUnknown(error).name,
        errorMessage: errorFromUnknown(error).message,
      });
    }
  }

  const {
    code,
    signal,
    logger,
    environment,
    attemptId,
    supervisorPid,
    bundle,
    deps,
  } = input;
  // `process.exit()` is synchronous. Terminal markers are therefore written
  // synchronously before exit rather than scheduling an append that the
  // process could abandon. Desktop uses these as fail-now readiness evidence.
  if (signal !== null) {
    logger.warn("Host child exited by signal", {
      environment,
      signal,
      exitCode: 128 + signalNumber(signal),
      attemptId,
    });
    return persistTerminalMarkerAndExit({
      deps,
      logger,
      environment,
      phase: "killed",
      fields: markerFields(attemptId, supervisorPid, {
        shell: undefined,
        args: undefined,
        bundle,
        exitCode: undefined,
        signal,
        error: undefined,
      }),
      exitCode: 128 + signalNumber(signal),
    });
  }
  if (code === null || code === 0) {
    logger.info("Host child exited cleanly", {
      environment,
      exitCode: code ?? 0,
      attemptId,
    });
    return persistTerminalMarkerAndExit({
      deps,
      logger,
      environment,
      phase: "exited",
      fields: markerFields(attemptId, supervisorPid, {
        shell: undefined,
        args: undefined,
        bundle,
        exitCode: code,
        signal: undefined,
        error: undefined,
      }),
      exitCode: code ?? 0,
    });
  }
  logger.error(
    "Host child exited with non-zero status",
    {
      environment,
      exitCode: code,
      attemptId,
    },
    null,
  );
  return persistTerminalMarkerAndExit({
    deps,
    logger,
    environment,
    phase: "crashed",
    fields: markerFields(attemptId, supervisorPid, {
      shell: undefined,
      args: undefined,
      bundle,
      exitCode: code,
      signal: undefined,
      error: undefined,
    }),
    exitCode: code,
  });
}

/**
 * Failure markers are meaningful only when the live launchd job can attest
 * itself.  An unattested failure deliberately remains ambiguity: it may
 * defer a reclaim, but can never authorise raw-host eviction.
 */
async function writeProbeTerminalIfAttested(input: {
  readonly context: LiveProbeContext | null;
  readonly attemptId: string;
  readonly supervisorPid: number;
  readonly reason: string;
  readonly deps: RunHostStartDeps;
  readonly environment: Environment;
}): Promise<void> {
  if (input.context === null) return;
  const attestation = await input.deps.attestProbeSupervisor(
    input.context.serviceLabel,
    input.supervisorPid,
  );
  if (attestation === null) return;
  await input.deps.writeProbeMarker(input.environment, {
    v: 1,
    transitionId: input.context.transitionId,
    probeNonce: input.context.probeNonce,
    serviceLabel: input.context.serviceLabel,
    supervisorPid: input.supervisorPid,
    attestation,
    outcome: { kind: "terminal", reason: input.reason },
  });
}

type ProbeObservation = { readonly marker: ProbeMarker | null };

async function observeProbeStatus(input: {
  readonly child: ChildProcess;
  readonly context: LiveProbeContext;
  readonly attemptId: string;
  readonly supervisorPid: number;
  readonly deps: RunHostStartDeps;
  readonly environment: Environment;
}): Promise<ProbeObservation> {
  const status = input.child.stdio[LAYER0_STATUS_FD];
  if (!isReadable(status)) return { marker: null };
  const read = await input.deps.readLayer0Frame(status, 3_000);
  if (read.kind !== "frame" || read.frame.attemptId !== input.attemptId) {
    return { marker: null };
  }
  const attestation = await input.deps.attestProbeSupervisor(
    input.context.serviceLabel,
    input.supervisorPid,
  );
  if (attestation === null) return { marker: null };
  const marker: ProbeMarker = {
    v: 1,
    transitionId: input.context.transitionId,
    probeNonce: input.context.probeNonce,
    serviceLabel: input.context.serviceLabel,
    supervisorPid: input.supervisorPid,
    attestation,
    outcome: mapLayer0FrameToProbeOutcome(read.frame),
  };
  await input.deps.writeProbeMarker(input.environment, marker);
  return { marker };
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === "object" &&
    value !== null &&
    "on" in value &&
    typeof value.on === "function"
  );
}

function persistTerminalMarkerAndExit(options: {
  readonly deps: RunHostStartDeps;
  readonly logger: ILogger;
  readonly environment: Environment;
  readonly phase: Exclude<BootstrapPhase, "starting">;
  readonly fields: BootstrapMarkerFields;
  readonly exitCode: number;
}): void {
  try {
    options.deps.writeTerminalMarker(
      options.environment,
      options.phase,
      options.fields,
    );
  } catch (cause) {
    options.logger.error(
      "Host supervisor could not persist terminal marker before exit",
      {
        environment: options.environment,
        phase: options.phase,
        exitCode: options.exitCode,
      },
      errorFromUnknown(cause),
    );
  } finally {
    // Marker persistence is best effort; it must never replace the child's
    // actual exit code or cause a spurious service-manager restart.
    options.deps.exit(options.exitCode);
  }
}

// Stamp every marker with the attempt's identity fields. Diagnostics stay
// caller-supplied so write sites remain explicit about which payload they
// attach (project style: no optional/default parameters).
function markerFields(
  attemptId: string,
  supervisorPid: number,
  fields: {
    readonly shell: string | undefined;
    readonly args: readonly string[] | undefined;
    readonly bundle: string | undefined;
    readonly exitCode: number | null | undefined;
    readonly signal: string | null | undefined;
    readonly error: string | undefined;
  },
): BootstrapMarkerFields {
  return {
    shell: fields.shell,
    args: fields.args,
    bundle: fields.bundle,
    exitCode: fields.exitCode,
    signal: fields.signal,
    error: fields.error,
    attemptId,
    supervisorPid,
  };
}

function signalNumber(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 2;
  if (signal === "SIGTERM") return 15;
  if (signal === "SIGHUP") return 1;
  if (signal === "SIGKILL") return 9;
  return 15;
}

export interface SpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

// Wrap a Windows `.cmd`/`.bat` host wrapper (the dev-desktop runtime) in an
// explicit, fully-quoted `cmd.exe /d /s /c "..."` invocation so a wrapper path
// containing spaces survives - bun/Node otherwise hand the spaced path to
// cmd.exe unquoted and it fails with "'C:\Users\Traycer' is not recognized".
// `/s /c "<line>"` makes cmd strip only the OUTERMOST quote pair and run
// `<line>` verbatim, so each token stays individually quoted. Non-Windows and
// real `.exe` hosts (production SEA) spawn directly. Exported for unit tests.
export function resolveSpawnInvocation(
  executable: string,
  args: readonly string[],
): SpawnInvocation {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const line = [executable, ...args].map((token) => `"${token}"`).join(" ");
    return {
      command: process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: executable, args, windowsVerbatimArguments: false };
}
