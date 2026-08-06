import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  closeRawFd,
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
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import {
  CRASH_REPORT_SCAN_TIMEOUT_MS,
  CRASH_REPORT_SPAWN_SLACK_MS,
  MAX_KEPT_CRASH_REPORTS,
  STDERR_END_WAIT_TIMEOUT_MS,
  STDERR_FLUSH_TIMEOUT_MS,
  StderrLogTee,
  type StderrTee,
  type CrashReportMatch,
  crashReportsDirFor,
  describeExitCode,
  describeFatalSignal,
  findCrashReportSince,
  prepareCrashReportsDir,
} from "../host/crash-diagnostics";
import { hostHomeDir } from "../store/paths";
import {
  hasActionableStopIntent,
  readStopIntentIdentity,
  type StopIntentIdentity,
} from "../host/stop-intent";
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

/**
 * Crash-relaunch budget (int #4826, from OSS #916).
 *
 * A host that crashes while the desktop app is CLOSED had no guardian: the
 * desktop health monitor is not running, launch converge needs a launch, and on
 * Windows the Scheduled Task's `RestartOnFailure` demonstrably did not relaunch
 * a task whose action exited `0xC0000409`. macOS (`KeepAlive{SuccessfulExit:
 * false}`) and Linux (`Restart=on-failure`) already do this; the supervisor now
 * does it itself so all three behave the same and Windows stops being the odd
 * one out.
 *
 * This layer sits UNDER those service managers, never replacing them: once the
 * budget is spent the supervisor exits with the child's own code, so launchd,
 * systemd, and the next Windows logon remain the outer backstop.
 */
export const MAX_CONSECUTIVE_RELAUNCHES = 5;

/**
 * Spacing before each relaunch, indexed by how many have already been made; the
 * last entry repeats. Deliberately faster off the mark than the desktop
 * governor's `[0, 60_000, 300_000]`: that one arbitrates while a user is
 * present and other recovery exists, whereas here the host is provably dead and
 * nothing else is watching. Caps at a minute so a machine that cannot start a
 * host is not hammered.
 */
export const RELAUNCH_BACKOFF_MS: readonly number[] = [
  1_000, 5_000, 15_000, 30_000, 60_000,
];

/**
 * How long a child must have RUN before its death is forgiven and the attempt
 * counter resets.
 *
 * Mirrors `SUSTAINED_HEALTH_MS` in the desktop's recovery governor, and for the
 * same hard-won reason recorded there: a single "it started" observation must
 * not re-arm the budget, because a host that dies 20s into boot every time
 * would then relaunch forever. Only real uptime counts.
 */
export const SUSTAINED_UPTIME_RESET_MS = 300_000;

/**
 * How long a child gets to honour a raced deliberate SIGTERM before the
 * supervisor escalates to SIGKILL.
 *
 * DERIVED from the shared constants rather than hand-tuned, and the derivation
 * is the safety property: a functioning host arms its own force-exit watchdog
 * at `SHUTDOWN_FORCE_EXIT_MS`, so a shorter grace would SIGKILL hosts that were
 * moments from completing the exact shutdown we asked for. Same rule, same
 * derivation, as `STOP_EXIT_TIMEOUT_MS` on the stop side - raising the watchdog
 * cannot silently leave this too short.
 *
 * What this covers is therefore only what that watchdog cannot: a child that
 * never armed it. That is a narrow case, and it is the one where waiting is
 * unbounded, which is the only reason this exists at all.
 */
export const RACED_STOP_KILL_GRACE_MS =
  SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;

/**
 * The signals a deliberate stop reaches this supervisor as, and which it
 * forwards to its child.
 *
 * This list decides which handlers get installed and NOTHING ELSE. It is
 * deliberately not used to classify a child's death: the same signal can
 * arrive from a service manager stopping us or from an operator killing the
 * child directly, and the name cannot tell those apart. Only the
 * `shuttingDown` latch and the stop-intent sentinel carry that evidence.
 */
const FORWARDED_SHUTDOWN_SIGNALS = [
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
] as const satisfies readonly NodeJS.Signals[];

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
  // Closes the supervisor's OWN copy of the log descriptor once an attempt is
  // over. The child received a duplicate at spawn time, so this never disturbs
  // a running host - it only stops descriptors accumulating one per attempt in
  // a supervisor that can now outlive many of them.
  readonly closeLogFd: (fd: number) => Promise<void>;
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
  // Crash-diagnostics operations. Injected so tests never touch the real
  // host data dir: the defaults create/prune/scan real directories and tee
  // real bytes into host.log.
  readonly prepareCrashReportsDir: (dir: string) => Promise<readonly string[]>;
  readonly findCrashReport: (
    dir: string,
    sinceMs: number,
    excludeNames: ReadonlySet<string>,
  ) => Promise<CrashReportMatch | null>;
  readonly createStderrTee: (environment: Environment) => StderrTee;
  // Relaunch-loop seams. `sleep` keeps the backoff out of wall-clock time in
  // tests (a five-attempt run would otherwise cost ~110s and make the suite
  // load-sensitive); `hasStopIntent` is the "was this death asked for?" check.
  readonly sleep: (ms: number) => Promise<void>;
  // Escalation timer for a raced deliberate stop. Injected for the same reason
  // as `sleep` - a 30s wait would make the suite load-sensitive - and returns
  // its own canceller so the caller never has to hold a timer handle.
  readonly escalateAfter: (ms: number, run: () => void) => () => void;
  // `ignoreRequestedBeforeMs` is this supervisor's invocation time: intent
  // older than that was served by our own start. Filtering rather than
  // deleting is what lets attempt one be guarded without a logon-started
  // supervisor refusing to start. See `host/stop-intent.ts`.
  // `servedAtStartup` is the clock-independent half: the record that existed
  // when this supervisor started, which it therefore has already answered.
  readonly hasStopIntent: (
    environment: Environment,
    nowMs: number,
    servedAtStartup: StopIntentIdentity | null,
  ) => Promise<boolean>;
  readonly readStopIntentIdentity: (
    environment: Environment,
  ) => Promise<StopIntentIdentity | null>;
  // Consecutive relaunches allowed before the supervisor gives up and hands
  // the machine back to launchd / systemd / the next logon. A dependency
  // rather than a bare constant so a test can state which behaviour it is
  // exercising: `0` pins a single attempt (the terminal-marker and
  // crash-diagnostics tests), a small number exercises exhaustion without
  // paying for five.
  readonly maxRelaunches: number;
}

const defaultRunDeps: RunHostStartDeps = {
  ...defaultDeps,
  spawn: (cmd, args, options) => nodeSpawn(cmd, args.slice(), options),
  findIncumbentHost: findLiveIncumbentHost,
  openLogFd: openBootstrapLogFd,
  closeLogFd: closeRawFd,
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
  prepareCrashReportsDir: (dir) =>
    prepareCrashReportsDir(dir, MAX_KEPT_CRASH_REPORTS),
  findCrashReport: findCrashReportSince,
  createStderrTee: (environment) => new StderrLogTee(environment),
  // NOT `unref()`ed, and that is load-bearing. During a backoff the child is
  // dead, its stderr is closed, and this supervisor has already released the
  // log descriptor - signal listeners do not ref the loop, and neither does an
  // awaited promise. An unref'd timer would be the only handle left, so Node
  // would drain and exit 0 in the middle of the wait and the relaunch this
  // whole feature exists for would silently never happen. Tests inject their
  // own `sleep`, so no test built on the harness can observe this; the
  // production-defaults suite asserts the timer stays referenced.
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  // Referenced, like `sleep`, and for a related reason: this timer is the only
  // thing that ends an otherwise unbounded wait on a child that will not honour
  // SIGTERM. Unref'ing it would let Node decide the supervisor had nothing left
  // to do and exit while the host it was told to stop kept serving - the exact
  // shape of the `sleep` defect, one path over. Cancelled as soon as the child
  // ends, so the reference costs nothing on the ordinary path.
  escalateAfter: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
  hasStopIntent: hasActionableStopIntent,
  readStopIntentIdentity,
  maxRelaunches: MAX_CONSECUTIVE_RELAUNCHES,
};

// Long-running entrypoint invoked by the OS service manager. Resolves
// the spawn target, kicks off the child, and only returns when the
// process exits via `deps.exit(...)`. Dependency-injected so tests can
// exercise the resolve / signal / spawn-failure branches without
// touching the real filesystem or process.
export const defaultRunHostStartDeps: RunHostStartDeps = defaultRunDeps;

/**
 * Every bootstrap-marker write in the supervisor goes through here, because a
 * marker is EVIDENCE and must never be control flow.
 *
 * `writeBootstrapMarker` is an `ensureHostHomeDir` plus an `appendFile`, and
 * both can reject for reasons that have nothing to do with whether the host
 * can run - a momentarily locked file on Windows, a transient EACCES, a full
 * disk. Awaited bare, that rejection escapes the relaunch loop entirely: the
 * entrypoint turns it into exit 1, and on the platform this ticket exists for
 * the Scheduled Task does not answer exit 1 with a fresh supervisor. A failed
 * diagnostic write would have left the machine hostless - the exact outcome
 * the loop was added to prevent, reached through the code that was supposed to
 * explain it.
 *
 * This is the rule the rest of the file already follows for diagnostics (the
 * stderr tee swallows, the probe observation is pre-caught, the terminal
 * marker write is wrapped); the loop's own marker writes were the sites that
 * had not been brought under it. Losing a marker costs a line of evidence.
 * Losing the supervisor costs the host.
 */
async function writeMarkerBestEffort(
  deps: Pick<RunHostStartDeps, "writeMarker">,
  logger: ILogger,
  environment: Environment,
  phase: BootstrapPhase,
  fields: BootstrapMarkerFields,
): Promise<void> {
  try {
    await deps.writeMarker(environment, phase, fields);
  } catch (cause) {
    logger.warn("Host supervisor could not write a bootstrap marker", {
      environment,
      phase,
      errorName: errorFromUnknown(cause).name,
      errorMessage: errorFromUnknown(cause).message,
    });
  }
}

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
  // Read before any other await, because it defines what "already served" means
  // for this whole invocation: whatever record is on disk NOW is one our own
  // existence answers - something asked for a start after asking for a stop, and
  // the start is the newer instruction. Every record that appears afterwards is
  // aimed at us.
  //
  // Deliberately NOT a timestamp comparison against our start. That was a proxy
  // for this same question, and it read a clock that moves: a backward step
  // makes a live stop look older than us (we relaunch a host the user stopped)
  // and simultaneously makes an already-answered record look future-dated (we
  // decline to spawn and exit 0, which no service manager answers). See
  // `hasActionableStopIntent`.
  const servedStopIntentAtStartup = await deps.readStopIntentIdentity(
    opts.environment,
  );
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

  // Was this supervisor started BY the service manager (launchd / systemd /
  // the Windows Scheduled Task), rather than by a person or by Desktop running
  // `traycer host start` and waiting on the result?
  //
  // It decides who gets to spend the relaunch budget on a FIRST-attempt target
  // or spawn failure. A service start has no caller listening: exiting hands
  // the machine back to the very restart mechanism this loop exists because it
  // cannot be trusted, which on Windows means the host stays down until the
  // next logon. An interactive or Desktop-driven start does have a caller, and
  // making it wait out the full ladder before reporting a genuinely broken
  // install would be a regression in a path that works today.
  //
  // Derived AFTER `probeContext`, and that placement is the substance rather
  // than style: a probe is a ONE-SHOT verdict owned by the install/restart
  // lifecycle and must never retry. Testing `serviceLabel` alone reads as
  // service-started for a LABEL-DERIVED probe too - a `--service-label` start
  // that picks up authority from a live transition journal - and would turn
  // its single honest answer into a retry loop.
  //
  // KNOWN LIMIT: the Windows launcher falls back to an UNLABELLED `host start`
  // if it cannot even ask the CLI whether it understands `--service-label`
  // (see `buildHiddenHostLauncher`). A start arriving through that degraded
  // path is indistinguishable from an interactive one and does not retry.
  const serviceStarted = serviceLabel !== null && probeContext === null;

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

  // ---- Relaunch loop ------------------------------------------------------
  //
  // Everything above this point is a GATE and runs exactly once: probe
  // authority, and the incumbent check that decides whether this supervisor
  // should exist at all. Everything below is per-attempt.
  let attemptNumber = 0;
  let consecutiveRelaunches = 0;
  let shuttingDown = false;
  let currentChild: ChildProcess | null = null;
  // Resolves the first time a shutdown signal arrives, so a backoff can be
  // ABANDONED rather than merely re-checked once it finishes.
  //
  // Waiting out a 60s backoff before noticing a stop is not just slow, it can
  // defeat the stop entirely. On a CLI-owned macOS host, `host restart` sends
  // `launchctl kill TERM`, then `stopService` waits only on the (already dead)
  // host pid and proceeds to `kickstart` - which no-ops while launchd still
  // considers this supervisor running (see `platforms/macos.ts`). By the time
  // the sleep ends and the latch is read, the restart has already no-op'd and
  // the machine is left hostless.
  let markShutdownRequested: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    markShutdownRequested = resolve;
  });

  // Registered ONCE for the supervisor's whole life. Five relaunches must not
  // install five listener sets, so the handler reads a mutable reference to
  // whichever child is current rather than closing over the first one.
  //
  // `shuttingDown` latches BEFORE the forward, and that ordering is the point:
  // `launchctl bootout` and `systemctl stop` stop the host by signalling THIS
  // process, which then kills its child - so without the latch that child's
  // death is indistinguishable from a crash and the loop would relaunch a host
  // in the middle of its own teardown. Setting the flag after forwarding would
  // leave a window where the exit is processed while it is still false.
  //
  // This is the POSIX half of the deliberate-stop guard. Windows needs the
  // other half (`host/stop-intent.ts`): there the supervisor is an orphaned
  // grandchild that `schtasks /End` never signals at all.
  const shutdownHandlers = FORWARDED_SHUTDOWN_SIGNALS.map((sig) => {
    const handler = (): void => {
      shuttingDown = true;
      markShutdownRequested();
      const child = currentChild;
      logger.debug("Host supervisor forwarding signal to child", {
        environment: opts.environment,
        signal: sig,
        childPidKnown: child?.pid !== undefined,
      });
      if (child !== null && child.pid !== undefined) {
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
    };
    process.on(sig, handler);
    return { sig, handler };
  });

  /**
   * Leave through here, not `deps.exit`, from anywhere below this point.
   *
   * The handlers above are registered for the loop's whole life. In production
   * `deps.exit` is `process.exit`, so they die with the process and removing
   * them is moot - but `runHostStart` is exported and an injected `exit` is
   * explicitly allowed to RETURN (that is why the dependency is typed `void`),
   * and every such call leaves three listeners on `process` behind.
   */
  const releaseShutdownHandlers = (): void => {
    for (const { sig, handler } of shutdownHandlers) {
      process.off(sig, handler);
    }
  };
  const exitSupervisor = (code: number): void => {
    releaseShutdownHandlers();
    return deps.exit(code);
  };

  for (;;) {
    attemptNumber += 1;
    const isFirstAttempt = attemptNumber === 1;
    // D5: a fresh id per attempt. `spawn-evidence.ts` pairs a post-baseline
    // `starting` marker with its terminal marker, so a relaunch has to read as
    // a genuinely new attempt rather than a second ending for the first one.
    const attemptId = randomUUID();
    // Probe authority is a ONE-SHOT verdict about a specific transition, owned
    // by the install/restart lifecycle. The first exit answers it honestly;
    // later relaunches are availability work and must never re-arm or
    // resurrect it.
    const attemptProbeContext = isFirstAttempt ? probeContext : null;

    // Re-ask the incumbent question before every RELAUNCH, not just at the top.
    //
    // The gate above answered it once, for a supervisor that used to die with
    // its child. This loop instead holds a claim on the data dir across a
    // backoff - seconds to minutes during which nothing is serving - which
    // materially widens the double-spawn window that gate's own comment
    // describes as only partly covered. `traycer host ensure` can legitimately
    // bring a host up in exactly that window (Desktop's launch converge does
    // this), and stacking a second one on top is the outcome the whole
    // incumbent policy exists to prevent.
    //
    // Declining is still never eviction: exit 0 and leave the winner alone.
    if (!isFirstAttempt && attemptProbeContext === null) {
      const relaunchIncumbent = await deps.findIncumbentHost(opts.environment);
      if (relaunchIncumbent !== null) {
        logger.warn(
          "Host supervisor abandoning relaunch - another host now owns this data dir",
          {
            environment: opts.environment,
            incumbentPid: relaunchIncumbent.pid,
            incumbentVersion: relaunchIncumbent.version,
            attemptId,
            supervisorPid,
          },
        );
        return exitSupervisor(0);
      }
    }

    // D5: re-resolved EVERY attempt, never cached. An install swap renames
    // `install/` aside mid-life, and a supervisor that held the first attempt's
    // path would relaunch a binary that has moved or vanished - today a fresh
    // launchd/systemd-spawned supervisor re-resolves, and the loop has to keep
    // that property.
    let target: HostStartTarget;
    try {
      target = await resolveHostStartTarget(opts, deps);
    } catch (err) {
      // Usually transient - mid-swap, or a still-settling install - so it
      // costs an attempt from the budget and retries.
      //
      // The first attempt retries only when nothing is waiting on the answer
      // (`serviceStarted`). A person or Desktop running `traycer host start`
      // against a genuinely broken install must still get the error now rather
      // than after the full ladder; a Scheduled Task action that exits here
      // instead leaves the machine hostless until the next logon, which is the
      // exact failure this loop exists to end.
      if (!isFirstAttempt || serviceStarted) {
        // Evidence first: a relaunch that could not resolve its target used to
        // retry silently, leaving `host.log` with a `starting` marker for an
        // attempt that never spawned and nothing to say why. int #4839 reads
        // exactly these markers to explain a failed start.
        await writeMarkerBestEffort(
          deps,
          logger,
          opts.environment,
          "failed-to-spawn",
          markerFields(
            attemptId,
            supervisorPid,
            {
              shell: undefined,
              args: undefined,
              bundle: undefined,
              exitCode: undefined,
              signal: undefined,
              error:
                err instanceof CliError
                  ? `${err.code}: ${err.message}`
                  : errorFromUnknown(err).message,
            },
            null,
          ),
        );
        const decision = await decideRelaunch({
          deps,
          logger,
          environment: opts.environment,
          reason: "target-resolution-failed",
          consecutiveRelaunches,
          isShuttingDown: () => shuttingDown,
          servedStopIntentAtStartup,
          shutdownRequested,
        });
        if (decision.kind === "relaunch") {
          consecutiveRelaunches = decision.consecutiveRelaunches;
          continue;
        }
        // A stop outranks the error that happened to be in flight when it
        // arrived. Reporting 69 here would be launchd's cue to start another
        // supervisor, which would resume this very retry - see
        // `RelaunchStopCause`.
        if (decision.cause === "stop-requested") return exitSupervisor(0);
        return exitSupervisor(err instanceof CliError ? err.exitCode : 1);
      }
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
        await writeMarkerBestEffort(
          deps,
          logger,
          opts.environment,
          "failed-to-spawn",
          markerFields(
            attemptId,
            supervisorPid,
            {
              shell: undefined,
              args: undefined,
              bundle: undefined,
              exitCode: undefined,
              signal: undefined,
              error: `${err.code}: ${err.message}`,
            },
            null,
          ),
        );
        await writeProbeTerminalIfAttested({
          context: attemptProbeContext,
          attemptId,
          supervisorPid,
          reason: `target-resolution-${err.code}`,
          deps,
          environment: opts.environment,
        });
        deps.onError(`traycer host start: ${err.code}: ${err.message}`);
        deps.onError(detailLine);
        return exitSupervisor(err.exitCode);
      }
      logger.error(
        "Host supervisor target resolution threw unexpectedly",
        { environment: opts.environment, exitCode: 1 },
        errorFromUnknown(err),
      );
      await writeProbeTerminalIfAttested({
        context: attemptProbeContext,
        attemptId,
        supervisorPid,
        reason: "target-resolution-unexpected",
        deps,
        environment: opts.environment,
      });
      // Leaving by `throw` is still leaving. A caller that catches this keeps
      // a stale handler set, and every stale handler goes on mutating the
      // `shuttingDown` of the run that installed it.
      releaseShutdownHandlers();
      throw err;
    }

    logger.info("Host supervisor target resolved", {
      environment: opts.environment,
      version: target.record.version,
      argCount: target.args.length,
      hasCwdOverride: opts.cwd !== null,
    });

    // Per-attempt setup, guarded as a UNIT.
    //
    // Every await below can fail for reasons that say nothing about whether the
    // host can run: `readEnvOverrides` and `rotateLog` touch files another
    // process may hold open, and `openLogFd` is an `fs.open` a Windows scanner
    // or a momentary EACCES can refuse. Awaited unguarded, any of them rejected
    // straight out of the relaunch loop; the entrypoint turned that into exit 1,
    // and exit 1 is what the Scheduled Task does NOT answer with a fresh
    // supervisor. A transient filesystem error could leave the machine hostless
    // - the outcome this loop exists to prevent.
    //
    // These are not diagnostics, so the best-effort treatment the marker writes
    // get would be wrong here: the attempt genuinely cannot proceed without
    // them. What they need is the policy target resolution and spawn already
    // have - spend an attempt from the bounded budget and retry, while a first
    // attempt with someone waiting on the answer still reports immediately.
    let env: NodeJS.ProcessEnv;
    let crashReportsDirPath: string;
    let preexistingReportNames: Set<string>;
    let logFd: number;
    try {
      const envOverrides = await deps.readEnvOverrides();
      logger.debug("Host supervisor loaded env overrides", {
        environment: opts.environment,
        overrideCount: Object.keys(envOverrides).length,
      });
      env = {
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

      // Create + prune the diagnostic-report destination BEFORE the spawn: the
      // relative `--report-directory=crash-reports` in NODE_OPTIONS resolves
      // against the child cwd, and a crash before the host's own runtime arming
      // must still have somewhere to land. Never throws.
      crashReportsDirPath = crashReportsDirFor(target.cwd);
      preexistingReportNames = new Set(
        await deps.prepareCrashReportsDir(crashReportsDirPath),
      );

      await writeMarkerBestEffort(
        deps,
        logger,
        opts.environment,
        "starting",
        markerFields(
          attemptId,
          supervisorPid,
          {
            shell: undefined,
            args: target.args,
            bundle: target.executable,
            exitCode: undefined,
            signal: undefined,
            error: undefined,
          },
          null,
        ),
      );

      logFd = await deps.openLogFd(opts.environment);
    } catch (err) {
      const failure = errorFromUnknown(err);
      logger.warn("Host supervisor attempt setup failed", {
        environment: opts.environment,
        attemptId,
        errorName: failure.name,
        errorMessage: failure.message,
      });
      // Evidence first, for the same reason the target-resolution path writes
      // one: this attempt may already have written `starting`, and
      // `spawn-evidence.ts` pairs that against a terminal marker. An attempt
      // that died in setup must not read as one still in progress.
      await writeMarkerBestEffort(
        deps,
        logger,
        opts.environment,
        "failed-to-spawn",
        markerFields(
          attemptId,
          supervisorPid,
          {
            shell: undefined,
            args: undefined,
            bundle: target.executable,
            exitCode: undefined,
            signal: undefined,
            error:
              err instanceof CliError
                ? `${err.code}: ${err.message}`
                : failure.message,
          },
          null,
        ),
      );
      if (!isFirstAttempt || serviceStarted) {
        const decision = await decideRelaunch({
          deps,
          logger,
          environment: opts.environment,
          reason: "attempt-setup-failed",
          consecutiveRelaunches,
          isShuttingDown: () => shuttingDown,
          servedStopIntentAtStartup,
          shutdownRequested,
        });
        if (decision.kind === "relaunch") {
          consecutiveRelaunches = decision.consecutiveRelaunches;
          continue;
        }
        // See `RelaunchStopCause`: a nonzero code here would be read as a crash
        // and answered with a fresh supervisor, undoing the stop just honoured.
        if (decision.cause === "stop-requested") return exitSupervisor(0);
        return exitSupervisor(err instanceof CliError ? err.exitCode : 1);
      }
      // First attempt with someone waiting: report now rather than after the
      // full ladder, and settle any probe that was attested against it.
      await writeProbeTerminalIfAttested({
        context: attemptProbeContext,
        attemptId,
        supervisorPid,
        reason: "attempt-setup-failed",
        deps,
        environment: opts.environment,
      });
      deps.onError(
        err instanceof CliError
          ? `traycer host start: ${err.code}: ${err.message}`
          : `traycer host start: ${failure.message}`,
      );
      return exitSupervisor(err instanceof CliError ? err.exitCode : 1);
    }
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
      ...(attemptProbeContext === null
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

    // Last look before committing to a child. BOTH halves of the
    // deliberate-stop guard are asked here, on EVERY attempt including the
    // first, because the two platforms deliver a stop by different channels
    // and this is the only point that dominates all of them.
    //
    // POSIX (`shuttingDown`): registering the signal handlers up front (once,
    // for the loop's whole life) SUPPRESSES Node's default "die on SIGTERM"
    // behaviour, which the single-shot supervisor used to rely on - it
    // installed its handler only after spawning, so a signal during setup
    // simply killed the process.
    //
    // Windows (stop intent): `schtasks /End` never signals this process at
    // all, so `shuttingDown` is ALWAYS false there. A latch-only check would
    // therefore be inert on the single platform this whole feature exists for.
    // `decideRelaunch` reads intent around the backoff, but per-attempt setup
    // is a chain of awaits AFTER that read - incumbent probe, target
    // resolution, env overrides, log rotation, crash-report pruning, marker
    // write, fd open - and `host stop` can complete inside it, having found no
    // child to kill because none exists yet.
    //
    // The intent read is sequenced BEFORE the latch, and that order is the
    // guard, not a style choice. `||` short-circuits, so asking `shuttingDown`
    // first would capture it as of BEFORE this await. A POSIX stop arriving
    // DURING the read - `launchctl bootout`, `systemctl stop`, or a CLI stop
    // whose best-effort intent write failed, i.e. every case with no file to
    // find - latches `shuttingDown` while `currentChild` is still null, so the
    // handler forwards the signal to nothing. A false intent answer then let
    // the spawn proceed, and the post-spawn guard could not catch it either:
    // that one is gated on `!shuttingDown`, which is true by then. The result
    // was a child created after a stop, never signalled, still serving.
    // Reading the latch AFTER the await is what closes it; from here to
    // `currentChild = child` is unbroken synchronous code, so no signal can
    // land in between.
    const stopAnnounced = await deps.hasStopIntent(
      opts.environment,
      Date.now(),
      servedStopIntentAtStartup,
    );
    if (shuttingDown || stopAnnounced) {
      logger.info("Host supervisor not spawning - a stop was requested", {
        environment: opts.environment,
        attemptId,
        attemptNumber,
        viaSignal: shuttingDown,
      });
      // This attempt already wrote its `starting` marker above. Returning
      // without a terminal one leaves `spawn-evidence.ts` pairing a
      // post-baseline `starting` against nothing, so a cleanly stopped host
      // reads as an attempt still in progress - the same unpaired-marker
      // defect a relaunch that could not resolve its target used to have.
      await writeMarkerBestEffort(
        deps,
        logger,
        opts.environment,
        "failed-to-spawn",
        markerFields(
          attemptId,
          supervisorPid,
          {
            shell: undefined,
            args: undefined,
            bundle: target.executable,
            exitCode: undefined,
            signal: undefined,
            error: "stop requested before spawn",
          },
          null,
        ),
      );
      await deps.closeLogFd(logFd);
      return exitSupervisor(0);
    }

    // Captured BEFORE the spawn: a loader-phase crash can write its diagnostic
    // report before any post-spawn statement runs, and the report scan treats
    // this as its lower bound (with additional slack for mtime granularity).
    const childSpawnedAtMs = Date.now();
    let child: ChildProcess;
    try {
      child = deps.spawn(launch.command, launch.args, {
        cwd: target.cwd,
        env,
        // Index LAYER0_STATUS_FD of this vector IS the descriptor named by
        // `--layer0-status-fd` above; the two must not drift apart. stdout
        // stays on the log fd; stderr is piped so the supervisor can tee it -
        // byte-for-byte into `host.log` BY PATH (a host-side log rotation
        // strands an fd-bound copy in `host.log.1`) plus a bounded in-memory
        // tail for the crash marker.
        stdio:
          attemptProbeContext === null
            ? ["ignore", logFd, "pipe"]
            : ["ignore", logFd, "pipe", "pipe"],
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
      await writeMarkerBestEffort(
        deps,
        logger,
        opts.environment,
        "failed-to-spawn",
        markerFields(
          attemptId,
          supervisorPid,
          {
            shell: undefined,
            args: undefined,
            bundle: target.executable,
            exitCode: undefined,
            signal: undefined,
            error: message,
          },
          null,
        ),
      );
      await writeProbeTerminalIfAttested({
        context: attemptProbeContext,
        attemptId,
        supervisorPid,
        reason: "host-spawn-failed",
        deps,
        environment: opts.environment,
      });
      deps.onError(
        `traycer host start: ${CLI_ERROR_CODES.HOST_SPAWN_FAILED}: ${message}`,
      );
      await deps.closeLogFd(logFd);
      // Identical policy to the ASYNCHRONOUS spawn failure below - whether
      // `spawn()` throws or reports through the `error` event is a platform
      // detail, not a difference in what the machine needs. Leaving the two
      // paths to disagree is how a transient EBUSY mid-swap could still exit a
      // supervisor that had budget left and nothing else watching.
      //
      // "Nothing else watching" is exactly what `serviceStarted` names, which
      // is why it also lifts the first-attempt exception here: gating on
      // attempt number alone reintroduced the same hole one attempt earlier.
      if (!isFirstAttempt || serviceStarted) {
        const decision = await decideRelaunch({
          deps,
          logger,
          environment: opts.environment,
          reason: "spawn-threw",
          consecutiveRelaunches,
          isShuttingDown: () => shuttingDown,
          servedStopIntentAtStartup,
          shutdownRequested,
        });
        if (decision.kind === "relaunch") {
          consecutiveRelaunches = decision.consecutiveRelaunches;
          continue;
        }
        // See `RelaunchStopCause`: 66 would be read as a crash and answered
        // with a fresh supervisor, undoing the stop this branch just honoured.
        if (decision.cause === "stop-requested") return exitSupervisor(0);
      }
      return exitSupervisor(66);
    }

    // Stderr tee (see the stdio comment above): bounded path-addressed mirror
    // into host.log plus the head+tail capture for the crash marker. Failures
    // are swallowed - a diagnostics write must never take the supervisor down.
    const stderrTee = deps.createStderrTee(opts.environment);
    // Resolves when the stderr stream ends (or errors). `exit` fires when the
    // process dies, NOT when its pipes have drained, so the finalize path waits
    // on THIS (bounded) before writing the marker - otherwise the fatal text can
    // still be unread in the pipe and the capture comes out empty in exactly the
    // abnormal-death case this feature exists for.
    let resolveStderrEnded: () => void = () => undefined;
    const stderrEnded = new Promise<void>((resolve) => {
      resolveStderrEnded = resolve;
    });
    if (child.stderr === null || child.stderr === undefined) {
      resolveStderrEnded();
    } else {
      const stderr = child.stderr;
      stderr.on("data", (chunk: Buffer) => {
        stderrTee.append(chunk);
      });
      // MANDATORY, not defensive: the stream is a live `Readable` this process
      // owns, and Node rethrows an unhandled stream `error` as an uncaught
      // exception. A read error on this pipe (EIO, or EPIPE after an abnormal
      // child death - i.e. precisely the crash case) would kill the supervisor
      // BEFORE it writes the terminal marker Desktop reads. Swallow it and
      // settle the wait: whatever bytes arrived are still worth recording, and
      // `error` may arrive instead of `end`.
      stderr.on("error", () => {
        resolveStderrEnded();
      });
      stderr.on("end", () => {
        resolveStderrEnded();
      });
      stderr.on("close", () => {
        resolveStderrEnded();
      });
    }

    const probeObservation =
      attemptProbeContext === null
        ? null
        : observeProbeStatus({
            child,
            context: attemptProbeContext,
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
    // The attempt's ending, AWAITED rather than fired-and-forgotten: the loop
    // cannot decide whether to bring the host back without knowing how it
    // died. `childFinalized` still guards the two listeners against
    // double-settling - it is now per-attempt state, which is what makes it
    // genuinely reusable rather than a one-shot latch on a process that was
    // about to exit anyway.
    currentChild = child;
    let childFinalized = false;
    // Constructed SYNCHRONOUSLY, so both listeners are attached before the
    // intent re-read below can yield. A child that died during that await
    // would otherwise emit `exit` with nothing listening, and this promise
    // would never settle.
    const childEnding = new Promise<ChildEnding>((resolve) => {
      const settle = (value: ChildEnding): void => {
        if (childFinalized) return;
        childFinalized = true;
        resolve(value);
      };
      // `spawn()` may report a failure asynchronously (notably ENOENT on some
      // platforms). It is an EventEmitter error, not a throw from spawn, so it
      // needs the same terminal-evidence path as a synchronous failure.
      child.once("error", (cause: Error) =>
        settle({ kind: "spawn-error", cause }),
      );
      child.once("exit", (code, signal) =>
        settle({ kind: "exit", code, signal }),
      );
    });

    // The pre-spawn guard closes the window it can see, but not a CROSS-PROCESS
    // one: `host stop` can write its intent just after that read returned
    // false, scan for a host while this child does not exist yet, find nothing
    // to kill, and return successfully - leaving a host running that the
    // stopper never saw. The stopper cannot fix this from its side, because it
    // has no way to wait for a process that has not been created.
    //
    // So the supervisor closes it from ours: having created the child, ask
    // once more, and undo the spawn if the answer changed. Latching
    // `shuttingDown` is what makes the death that follows read as requested
    // rather than as a crash to be recovered.
    if (
      !shuttingDown &&
      (await deps.hasStopIntent(
        opts.environment,
        Date.now(),
        servedStopIntentAtStartup,
      ))
    ) {
      logger.info("Host supervisor stopping a child a stop raced", {
        environment: opts.environment,
        attemptId,
        childPidKnown: child.pid !== undefined,
      });
      shuttingDown = true;
      markShutdownRequested();
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone - the ending below still settles.
      }
      // Bounded, because on THIS path nothing else escalates. The forwarded
      // path is signalled by launchd/systemd, which follow up with SIGKILL
      // against the job; here the stop announced itself on disk, `host stop`
      // has already returned, and no one is watching this supervisor. A child
      // that never handles SIGTERM would leave `await childEnding` below
      // waiting forever, holding the job slot open while the host it was told
      // to stop keeps serving.
      //
      // The grace is DERIVED, not chosen: a functioning host arms its own
      // force-exit watchdog at `SHUTDOWN_FORCE_EXIT_MS`, so anything shorter
      // would SIGKILL hosts that were about to complete the very shutdown we
      // asked for - destroying a clean exit to save a few seconds. Same
      // reasoning, and the same derivation, as `STOP_EXIT_TIMEOUT_MS`. What is
      // left is the case that watchdog cannot cover: a child that never armed
      // it.
      const escalation = deps.escalateAfter(RACED_STOP_KILL_GRACE_MS, () => {
        logger.warn("Host supervisor escalating a raced stop to SIGKILL", {
          environment: opts.environment,
          attemptId,
          graceMs: RACED_STOP_KILL_GRACE_MS,
        });
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      });
      void childEnding.finally(escalation);
    }

    const ending = await childEnding;
    // Stamped HERE, at the child's death, not where uptime is finally compared.
    // Everything between the two is diagnostics - the stderr end wait (2s), the
    // tee flush (1s) and the bounded crash-report scan (2s) - so reading the
    // clock later credits a dead child with up to five seconds it did not run.
    // That is enough to carry a host that died just short of
    // `SUSTAINED_UPTIME_RESET_MS` over the line and reset the budget, which is
    // the governor's own re-arming bug in a narrower window.
    const childEndedAtMs = Date.now();
    currentChild = null;

    if (ending.kind === "spawn-error") {
      await deps.closeLogFd(logFd);
      await persistAsyncChildSpawnFailure({
        cause: ending.cause,
        deps,
        logger,
        environment: opts.environment,
        attemptId,
        supervisorPid,
        bundle: target.executable,
        probeContext: attemptProbeContext,
      });
      // Same reasoning as a failed re-resolve: usually transient, so it spends
      // budget and retries, and a first attempt does so only when nothing is
      // waiting on the answer.
      if (!isFirstAttempt || serviceStarted) {
        const decision = await decideRelaunch({
          deps,
          logger,
          environment: opts.environment,
          reason: "spawn-failed",
          consecutiveRelaunches,
          isShuttingDown: () => shuttingDown,
          servedStopIntentAtStartup,
          shutdownRequested,
        });
        if (decision.kind === "relaunch") {
          consecutiveRelaunches = decision.consecutiveRelaunches;
          continue;
        }
        // See `RelaunchStopCause`: 66 would be read as a crash and answered
        // with a fresh supervisor, undoing the stop this branch just honoured.
        if (decision.cause === "stop-requested") return exitSupervisor(0);
      }
      return exitSupervisor(66);
    }

    // The child is gone, so the supervisor's own copy of the log descriptor has
    // no further use. Released HERE rather than at process exit because this
    // process now outlives many attempts: a sustained-uptime reset can extend
    // the loop indefinitely, which would otherwise leak one descriptor per
    // relaunch for the life of the machine.
    await deps.closeLogFd(logFd);

    const outcome = await persistChildExit({
      code: ending.code,
      signal: ending.signal,
      deps,
      logger,
      environment: opts.environment,
      attemptId,
      supervisorPid,
      bundle: target.executable,
      probeObservation,
      childSpawnedAtMs,
      stderrTee,
      stderrEnded,
      crashReportsDirPath,
      preexistingReportNames,
    });

    // The diagnostic wait above is bounded precisely BECAUSE a grandchild can
    // inherit the dead host's stderr and hold the pipe open indefinitely. When
    // that bound expires the stream is still live, still has a `data` listener
    // feeding this attempt's tee, and still holds a libuv handle - so a
    // supervisor that goes on to relaunch keeps every one of them, per attempt,
    // for as long as it lives. The five-relaunch budget does not bound that: a
    // child surviving the sustained-uptime window resets the counter, so spaced
    // crash cycles accumulate without limit. Same argument as the log fd.
    //
    // Best-effort and deliberately last: the marker and the capture have both
    // already been written from this stream by the time we get here.
    const attemptStderr = child.stderr;
    if (attemptStderr !== null && attemptStderr !== undefined) {
      attemptStderr.removeAllListeners("data");
      try {
        attemptStderr.destroy();
      } catch {
        // A stream that is already closed must not end the supervisor.
      }
    }

    // A clean exit is the host standing down on purpose - never relaunch it.
    // This is `KeepAlive{SuccessfulExit: false}` and `Restart=on-failure`
    // restated, which is the point: one semantic on all three platforms.
    if (!outcome.abnormal) {
      return exitSupervisor(outcome.exitCode);
    }

    // D7: only real uptime forgives the budget. The desktop recovery governor
    // records why a weaker rule is wrong - a host that dies shortly after boot
    // every time answers "it started" every time, and treating that as recovery
    // is what let the original respawn loop re-arm itself forever.
    const ranForMs = childEndedAtMs - childSpawnedAtMs;
    if (ranForMs >= SUSTAINED_UPTIME_RESET_MS) {
      consecutiveRelaunches = 0;
    }

    const decision = await decideRelaunch({
      deps,
      logger,
      environment: opts.environment,
      reason: ending.signal !== null ? "fatal-signal" : "crashed",
      consecutiveRelaunches,
      isShuttingDown: () => shuttingDown,
      servedStopIntentAtStartup,
      shutdownRequested,
    });
    if (decision.kind !== "relaunch") {
      // The load-bearing one. A stop landing during the backoff is the case
      // `refused("after")` exists for, and the child it interrupts died
      // abnormally by definition - so `outcome.exitCode` is nonzero, and
      // reporting it would have launchd start a replacement supervisor that
      // reads the intent as already served and brings the host back. The
      // refusal and the exit code have to agree. See `RelaunchStopCause`.
      return exitSupervisor(
        decision.cause === "stop-requested" ? 0 : outcome.exitCode,
      );
    }
    consecutiveRelaunches = decision.consecutiveRelaunches;
  }
}

type ChildEnding =
  | { readonly kind: "spawn-error"; readonly cause: Error }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

type RelaunchDecision =
  | { readonly kind: "relaunch"; readonly consecutiveRelaunches: number }
  | { readonly kind: "stop"; readonly cause: RelaunchStopCause };

/**
 * WHY the loop stopped, because the two answers need opposite exit codes.
 *
 * `stop-requested` must exit 0. Nothing else in the exit path can express "do
 * not bring this back": `KeepAlive{SuccessfulExit:false}`, `Restart=on-failure`
 * and the Scheduled Task's `RestartOnFailure` all read a nonzero exit as a crash
 * and start a fresh supervisor - which then reads the stop intent as older than
 * its own invocation, treats it as already served, and starts the host. The
 * refusal would hold for one process and be undone by the next.
 *
 * `budget-exhausted` keeps the child's own nonzero code, deliberately: after
 * five relaunches this supervisor stops guessing and hands the machine back to
 * the platform, whose throttling is the outer bound on the loop.
 */
type RelaunchStopCause = "stop-requested" | "budget-exhausted";

/**
 * The single place that answers "may this dead child be brought back?".
 *
 * Three refusals:
 *
 *  1. **Shutting down.** The POSIX stop path signals this supervisor, which
 *     forwards to the child; relaunching there fights our own teardown.
 *  2. **Budget.** Exhaustion exits with the child's own code, handing the
 *     machine back to launchd / systemd / the next logon rather than spinning.
 *  3. **Stop intent.** The Windows stop path never signals this process at all
 *     (`schtasks /End` kills only the task's root `wscript.exe`), so a stop
 *     announces itself on disk instead.
 *
 * ### The refusals are re-evaluated AFTER the backoff, not only before it
 *
 * This is the whole correctness of the guard, and an earlier revision got it
 * wrong: it sampled both signals once and then slept for up to a minute, so a
 * `traycer host stop` or a `launchctl bootout` arriving DURING that backoff was
 * decided against before it happened, and the supervisor spawned a replacement
 * for a host the user had just stopped. The backoff window is precisely when a
 * stop is most likely to land, because the host is already down and that is
 * when a person or an installer acts.
 *
 * `isShuttingDown` is therefore a getter, not a boolean: a snapshot taken
 * before an await cannot observe a signal that arrives during it.
 *
 * A relaunch that survives all three still has to get past the incumbent
 * re-check at the top of the next iteration.
 */
async function decideRelaunch(input: {
  readonly deps: RunHostStartDeps;
  readonly logger: ILogger;
  readonly environment: Environment;
  readonly reason: string;
  readonly consecutiveRelaunches: number;
  readonly isShuttingDown: () => boolean;
  readonly servedStopIntentAtStartup: StopIntentIdentity | null;
  readonly shutdownRequested: Promise<void>;
}): Promise<RelaunchDecision> {
  const { deps, logger, environment, reason } = input;
  const refused = async (when: "before" | "after"): Promise<boolean> => {
    if (input.isShuttingDown()) {
      logger.info("Host supervisor not relaunching - shutting down", {
        environment,
        reason,
        observed: when,
      });
      return true;
    }
    if (
      await deps.hasStopIntent(
        environment,
        Date.now(),
        input.servedStopIntentAtStartup,
      )
    ) {
      logger.info("Host supervisor not relaunching - a stop was requested", {
        environment,
        reason,
        observed: when,
      });
      return true;
    }
    return false;
  };

  // Checked before the sleep too - purely so an already-known stop does not
  // pay a minute of backoff before being honoured.
  if (await refused("before")) return { kind: "stop", cause: "stop-requested" };
  if (input.consecutiveRelaunches >= deps.maxRelaunches) {
    logger.error(
      "Host supervisor relaunch budget exhausted - leaving the host down",
      {
        environment,
        reason,
        attempts: input.consecutiveRelaunches,
      },
      null,
    );
    return { kind: "stop", cause: "budget-exhausted" };
  }
  // `Math.min` keeps the index in range, so the lookup cannot be undefined;
  // the last entry repeats for every attempt past the ladder's length.
  const backoffMs =
    RELAUNCH_BACKOFF_MS[
      Math.min(input.consecutiveRelaunches, RELAUNCH_BACKOFF_MS.length - 1)
    ] ??
    RELAUNCH_BACKOFF_MS[RELAUNCH_BACKOFF_MS.length - 1] ??
    1_000;
  // The only evidence a support pull will have that this loop ran at all.
  logger.warn("Host supervisor relaunching the host", {
    environment,
    reason,
    attempt: input.consecutiveRelaunches + 1,
    maxAttempts: deps.maxRelaunches,
    backoffMs,
  });
  // Whichever comes first. A shutdown signal ENDS the wait rather than being
  // noticed after it - see the note on `shutdownRequested`. The Windows
  // sentinel has no such edge to race against, so it is still caught by the
  // re-read below; there the cost of waiting is latency, not a defeated stop.
  await Promise.race([deps.sleep(backoffMs), input.shutdownRequested]);
  // The load-bearing one: a stop that landed while we slept.
  if (await refused("after")) return { kind: "stop", cause: "stop-requested" };
  return {
    kind: "relaunch",
    consecutiveRelaunches: input.consecutiveRelaunches + 1,
  };
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
  await writeMarkerBestEffort(
    input.deps,
    input.logger,
    input.environment,
    "failed-to-spawn",
    markerFields(
      input.attemptId,
      input.supervisorPid,
      {
        shell: undefined,
        args: undefined,
        bundle: input.bundle,
        exitCode: undefined,
        signal: undefined,
        error: message,
      },
      null,
    ),
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
  readonly childSpawnedAtMs: number;
  readonly stderrTee: StderrTee;
  readonly stderrEnded: Promise<void>;
  readonly crashReportsDirPath: string;
  readonly preexistingReportNames: ReadonlySet<string>;
}): Promise<ChildExitOutcome> {
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
  // TWO waits, and they are not interchangeable. First: let the stderr pipe
  // reach `end` - `exit` does not imply drained pipes, so without this the
  // capture can be empty precisely when the child died hard. Second: drain
  // the tee's queued `appendFile` writes, which `process.exit()` below would
  // otherwise abandon. Both are bounded, because a grandchild holding the
  // inherited stderr fd can keep the stream open indefinitely and a
  // diagnostics path must never hang the supervisor's exit.
  await withDeadline(input.stderrEnded, STDERR_END_WAIT_TIMEOUT_MS);
  await input.stderrTee.flush(STDERR_FLUSH_TIMEOUT_MS);
  // `process.exit()` is synchronous. Terminal markers are therefore written
  // synchronously before exit rather than scheduling an append that the
  // process could abandon. Desktop uses these as fail-now readiness evidence.
  if (signal !== null) {
    // A fatal signal is a CRASH, not a shutdown: a Node fatal abort surfaces
    // on macOS/Linux as `code=null, signal=SIGABRT`, and routing it through
    // the bare killed path would discard the report and stderr evidence
    // exactly where it matters most. Forwarded shutdown signals stay bare.
    const fatalMeaning = describeFatalSignal(signal);
    const crashReport =
      fatalMeaning === null ? null : await boundedCrashReportScan(input);
    logger.warn("Host child exited by signal", {
      environment,
      signal,
      exitCode: 128 + signalNumber(signal),
      attemptId,
    });
    if (fatalMeaning !== null) {
      // Same support-log line as the nonzero-exit crash branch: a POSIX
      // fatal is the same event wearing a signal, and cli.log is where a
      // support pull reads the OOM-vs-native answer.
      logger.error(
        "Host crash diagnostics",
        {
          environment,
          attemptId,
          exitMeaning: fatalMeaning,
          report: crashReport?.filename ?? "none",
          reportSummary: crashReport?.summary ?? "none",
        },
        null,
      );
    }
    return persistTerminalMarker({
      deps,
      logger,
      environment,
      phase: "killed",
      fields: markerFields(
        attemptId,
        supervisorPid,
        {
          shell: undefined,
          args: undefined,
          bundle,
          exitCode: undefined,
          signal,
          error: undefined,
        },
        fatalMeaning === null
          ? null
          : {
              exitMeaning: fatalMeaning,
              report: crashReport?.filename,
              stderrTail: input.stderrTee.capture.isEmpty()
                ? undefined
                : input.stderrTee.capture.escapedForMarker(),
            },
      ),
      exitCode: 128 + signalNumber(signal),
      // EVERY signal death is abnormal here, and the deliberate-stop question
      // is answered where it is actually known - `decideRelaunch`, which reads
      // the `shuttingDown` latch and the stop-intent file.
      //
      // Two earlier shapes of this line were both wrong, in the same way:
      // they answered "was this death asked for" with a proxy.
      //
      //   1. `fatalMeaning !== null` used `describeFatalSignal`, which answers
      //      "can this be explained in a support log" - a narrow whitelist of
      //      native-crash signals that deliberately omits SIGKILL. An
      //      OOM-killed host, the likeliest signal death on Linux, was never
      //      relaunched.
      //   2. `!isForwardedShutdownSignal(signal)` used the signal NAME. But a
      //      name only says the signal COULD have been forwarded, not that it
      //      was: an operator or watchdog signalling the child directly leaves
      //      the latch false and no intent on disk, and the host stayed down.
      //
      // The signal carries no evidence about intent. Only the latch and the
      // sentinel do, and both are already consulted downstream.
      abnormal: true,
    });
  }
  if (code === null || code === 0) {
    logger.info("Host child exited cleanly", {
      environment,
      exitCode: code ?? 0,
      attemptId,
    });
    return persistTerminalMarker({
      deps,
      logger,
      environment,
      phase: "exited",
      fields: markerFields(
        attemptId,
        supervisorPid,
        {
          shell: undefined,
          args: undefined,
          bundle,
          exitCode: code,
          signal: undefined,
          error: undefined,
        },
        null,
      ),
      exitCode: code ?? 0,
      abnormal: false,
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
  // Crash enrichment: decode the exit status, reference the diagnostic
  // report this child wrote (if any), and attach the stderr capture - the
  // fatal-error text that used to be stranded in a rotated-away log
  // generation. All best-effort and time-bounded; the marker must be
  // written regardless.
  const exitMeaning = describeExitCode(code) ?? undefined;
  const crashReport = await boundedCrashReportScan(input);
  if (exitMeaning !== undefined || crashReport !== null) {
    logger.error(
      "Host crash diagnostics",
      {
        environment,
        attemptId,
        exitMeaning: exitMeaning ?? "unknown",
        report: crashReport?.filename ?? "none",
        reportSummary: crashReport?.summary ?? "none",
      },
      null,
    );
  }
  return persistTerminalMarker({
    deps,
    logger,
    environment,
    phase: "crashed",
    fields: markerFields(
      attemptId,
      supervisorPid,
      {
        shell: undefined,
        args: undefined,
        bundle,
        exitCode: code,
        signal: undefined,
        error: undefined,
      },
      {
        exitMeaning,
        report: crashReport?.filename,
        stderrTail: input.stderrTee.capture.isEmpty()
          ? undefined
          : input.stderrTee.capture.escapedForMarker(),
      },
    ),
    exitCode: code,
    abnormal: true,
  });
}

/**
 * Report scan bounded by {@link CRASH_REPORT_SCAN_TIMEOUT_MS}: the terminal
 * marker is readiness authority and must not be lost to a slow disk - past
 * the budget the marker goes out without a `report=` field. The lower bound
 * gets {@link CRASH_REPORT_SPAWN_SLACK_MS} of slack for loader-phase crashes
 * and mtime granularity.
 */
function boundedCrashReportScan(input: {
  readonly deps: RunHostStartDeps;
  readonly crashReportsDirPath: string;
  readonly childSpawnedAtMs: number;
  readonly preexistingReportNames: ReadonlySet<string>;
}): Promise<CrashReportMatch | null> {
  return Promise.race([
    // `.catch` is load-bearing, not decoration. `persistChildExit` is invoked
    // as `void persistChildExit(...)`, so a rejection here would skip the
    // terminal marker AND `deps.exit` - leaving the supervisor alive with no
    // evidence written, which is strictly worse than having no `report=`
    // field. The default implementation swallows its own I/O errors, but the
    // INJECTED dependency contract makes no such promise.
    input.deps
      .findCrashReport(
        input.crashReportsDirPath,
        input.childSpawnedAtMs - CRASH_REPORT_SPAWN_SLACK_MS,
        input.preexistingReportNames,
      )
      .catch(() => null),
    new Promise<null>((resolve) => {
      const timer = setTimeout(
        () => resolve(null),
        CRASH_REPORT_SCAN_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * Resolves when `promise` settles or `timeoutMs` elapses, whichever is first.
 * Never rejects: every caller here is on the exit path, where the only
 * acceptable outcome is "continue and write the marker".
 */
function withDeadline(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
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

/**
 * Writes the attempt's terminal marker and reports how the child died.
 *
 * Deliberately no longer exits the process. The marker is per-ATTEMPT evidence
 * (Desktop's readiness authority reads it, and `spawn-evidence.ts` pairs it
 * with that attempt's `starting` marker), whereas exiting is a decision about
 * the SUPERVISOR - which now outlives individual attempts. Collapsing the two
 * is what made a crash necessarily fatal to the supervisor.
 */
function persistTerminalMarker(options: {
  readonly deps: RunHostStartDeps;
  readonly logger: ILogger;
  readonly environment: Environment;
  readonly phase: Exclude<BootstrapPhase, "starting">;
  readonly fields: BootstrapMarkerFields;
  readonly exitCode: number;
  readonly abnormal: boolean;
}): ChildExitOutcome {
  try {
    options.deps.writeTerminalMarker(
      options.environment,
      options.phase,
      options.fields,
    );
  } catch (cause) {
    options.logger.error(
      "Host supervisor could not persist terminal marker",
      {
        environment: options.environment,
        phase: options.phase,
        exitCode: options.exitCode,
      },
      errorFromUnknown(cause),
    );
  }
  // Marker persistence is best effort; it must never replace the child's
  // actual exit code or cause a spurious service-manager restart.
  return { exitCode: options.exitCode, abnormal: options.abnormal };
}

export interface ChildExitOutcome {
  readonly exitCode: number;
  // Whether this is the kind of death the relaunch loop exists for. A clean
  // exit (including the incumbent-declined path) and a forwarded shutdown
  // signal are NOT abnormal; a nonzero exit and a fatal signal are.
  readonly abnormal: boolean;
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
  // Crash-only enrichment (decoded exit status, diagnostic-report reference,
  // stderr tail). `null` everywhere except the `phase=crashed` writer.
  diagnostics: {
    readonly exitMeaning: string | undefined;
    readonly report: string | undefined;
    readonly stderrTail: string | undefined;
  } | null,
): BootstrapMarkerFields {
  return {
    shell: fields.shell,
    args: fields.args,
    bundle: fields.bundle,
    exitCode: fields.exitCode,
    signal: fields.signal,
    error: fields.error,
    exitMeaning: diagnostics?.exitMeaning,
    report: diagnostics?.report,
    stderrTail: diagnostics?.stderrTail,
    attemptId,
    supervisorPid,
  };
}

function signalNumber(signal: NodeJS.Signals): number {
  // The platform's own table first: the newly crash-classified fatal signals
  // (SIGABRT, SIGSEGV, ...) must map to their real numbers - reporting
  // SIGABRT as the generic 15 fallback (exit 143 instead of 134) misfiles
  // the crash for every consumer of the supervisor's exit code. Some numbers
  // are platform-dependent (SIGBUS is 7 on Linux, 10 on macOS), which is why
  // this is a lookup, not a table.
  const known = osConstants.signals[signal];
  if (typeof known === "number") {
    return known;
  }
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
