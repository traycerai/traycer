import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants as osConstants } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import {
  defaultRunHostStartDeps,
  MAX_CONSECUTIVE_RELAUNCHES,
  RACED_STOP_KILL_GRACE_MS,
  RELAUNCH_BACKOFF_MS,
  resolveHostStartTarget,
  SUSTAINED_UPTIME_RESET_MS,
  MAX_IMMEDIATE_RESTARTS,
  runHostStart,
  type HostStartTarget,
  type RunHostStartDeps,
} from "../host-start";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { ILogger } from "../../logger";
import type { Layer0FrameRead } from "../../host/lifecycle-probe";
import {
  CRASH_REPORT_SPAWN_SLACK_MS,
  STDERR_END_WAIT_TIMEOUT_MS,
  STDERR_HEAD_MAX_BYTES,
  STDERR_TAIL_MAX_BYTES,
  StderrCaptureBuffer,
  type CrashReportMatch,
  type StderrTee,
} from "../../host/crash-diagnostics";
import {
  RESTART_EXIT_CODE,
  SHUTDOWN_FORCE_EXIT_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import type { Environment } from "../../runner/environment";
import type { StopIntentIdentity } from "../../host/stop-intent";
import { hostHomeDir } from "../../store/paths";
import { withDevDesktopSlotAsync as withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";
import type { ProbeMarker } from "@traycer-clients/shared/host-lifecycle";

// `traycer host start --environment <ch>` is the single supervisor entry
// point. There is one launch path: read the environment's
// HostInstallRecord, refuse to spawn with stable machine-readable
// codes when the record is missing / the executable is gone, and
// otherwise spawn `record.executablePath` directly. The dev orchestrator
// (`make dev-desktop`) stages a tiny wrapper script as the executable
// so the same code path covers SEA-installed prod hosts and node-
// bundled dev hosts - see `scripts/dev-desktop.js::stageHostDevRuntime`.

function sampleRecord(executablePath: string): HostInstallRecord {
  return {
    installId: null,
    version: "1.0.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-05-15T00:00:00.000Z",
    source: { kind: "registry", value: "1.0.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-05-15T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

describe("resolveHostStartTarget", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "traycer-host-start-target-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("returns the install record's executablePath as the spawn target", async () => {
    const execPath = join(work, "traycer-host");
    writeFileSync(execPath, "#!/bin/sh\nexit 0\n");
    const target = await resolveHostStartTarget(
      { environment: "production", cwd: null },
      {
        readInstallRecord: async () => sampleRecord(execPath),
        pathExists: (p) => Promise.resolve(p === execPath),
      },
    );
    expect(target.executable).toBe(execPath);
    // Passes the resolved slot dir so a host baked for a different slot still
    // publishes pid.json where this environment expects it.
    expect(target.args).toEqual(["--host-data-dir", hostHomeDir("production")]);
    // The host home dir, never the executable's own directory: a CWD inside
    // `install/` is an open handle children inherit, and on Windows any such
    // child that outlives the pre-update kill fails the install swap rename
    // with EBUSY.
    expect(target.cwd).toBe(hostHomeDir("production"));
    expect(target.cwd).not.toBe(work);
    expect(target.record.version).toBe("1.0.0");
  });

  it("throws HOST_NOT_INSTALLED with the environment when no record exists", async () => {
    let thrown: unknown;
    try {
      await resolveHostStartTarget(
        { environment: "dev", cwd: null },
        {
          readInstallRecord: async () => null,
          pathExists: () => Promise.resolve(false),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(CLI_ERROR_CODES.HOST_NOT_INSTALLED);
    expect(err.details).toMatchObject({ environment: "dev" });
    // exitCode must be stable so the service manager can branch on it.
    expect(err.exitCode).toBe(69);
  });

  it("throws HOST_NOT_INSTALLED when the record's executablePath does not exist on disk", async () => {
    let thrown: unknown;
    try {
      await resolveHostStartTarget(
        { environment: "production", cwd: null },
        {
          readInstallRecord: async () => sampleRecord(join(work, "nope")),
          pathExists: () => Promise.resolve(false),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(CLI_ERROR_CODES.HOST_NOT_INSTALLED);
    expect(err.details).toMatchObject({
      environment: "production",
      version: "1.0.0",
    });
  });

  it("throws HOST_INSTALL_RECORD_INVALID when executablePath is empty", async () => {
    let thrown: unknown;
    try {
      await resolveHostStartTarget(
        { environment: "production", cwd: null },
        {
          readInstallRecord: async () => sampleRecord(""),
          pathExists: () => Promise.resolve(true),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe(
      CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    );
  });
});

// --------------------------------- runHostStart full-flow tests

interface StubChild extends EventEmitter {
  pid: number | undefined;
  kill: (signal: NodeJS.Signals) => boolean;
  stderr: PassThrough | null;
}

function makeStubChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  emitter.pid = 4242;
  emitter.kill = () => true;
  emitter.stderr = null;
  return emitter;
}

function makeStubChildWithStderr(): StubChild {
  const child = makeStubChild();
  child.stderr = new PassThrough();
  return child;
}

/**
 * The ONE place this file bridges `StubChild` to `ChildProcess`.
 *
 * `StubChild` is an EventEmitter standing in for a real child process, and no
 * structural type bridges those. Owning the conversion here keeps the
 * assertion out of every call site - which is the point of the guideline
 * against `as unknown` and chained assertions: one reviewed bridge, not nine
 * unreviewed ones.
 */
function asChildProcess(child: StubChild): ChildProcess {
  const bridged: unknown = child;
  return bridged as ChildProcess;
}

interface Recorded {
  readonly markers: Array<{
    readonly environment: string;
    readonly phase: string;
    readonly fields: Record<string, unknown>;
  }>;
  readonly errors: string[];
  exited: number | null;
  readonly exitWaiters: Array<() => void>;
  // Log rotations attempted, in order. Stubbed (not left to the real helper) so
  // a test run can never rotate the developer's actual ~/.traycer host log.
  readonly rotations: string[];
  // Ordered trace of the start lifecycle: rotate -> marker -> open fd -> spawn.
  // The ORDER is the invariant (see the ordering test), not just the calls.
  readonly sequence: string[];
  readonly spawnCalls: Array<{
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    env: Record<string, string | undefined>;
    stdio: unknown;
    windowsHide: boolean | undefined;
  }>;
  // Crash-diagnostics DI observations (never touch real ~/.traycer).
  readonly preparedCrashReportDirs: string[];
  /** Names returned by the injected prepareCrashReportsDir (pre-existing set). */
  prepareCrashReportsReturn: readonly string[];
  readonly findCrashReportCalls: Array<{
    dir: string;
    sinceMs: number;
    excludeNames: ReadonlySet<string>;
  }>;
  findCrashReportResult: CrashReportMatch | null;
  /** When set, findCrashReport never resolves (scan-timeout path). */
  findCrashReportHangs: boolean;
  /** When set, findCrashReport rejects (must not skip marker/exit). */
  findCrashReportRejects: boolean;
  lastStderrTee: MemoryStderrTee | null;
  readonly stderrTees: MemoryStderrTee[];
  readonly loggerErrors: Array<{
    message: string;
    fields: Record<string, unknown>;
  }>;
}

/**
 * Capture-only stderr tee: never opens host.log. Typed as StderrTee so no
 * cast is required (concrete StderrLogTee private fields stay out of deps).
 */
class MemoryStderrTee implements StderrTee {
  readonly flushTimeouts: number[] = [];
  readonly capture = new StderrCaptureBuffer(
    STDERR_HEAD_MAX_BYTES,
    STDERR_TAIL_MAX_BYTES,
  );

  append(chunk: Buffer): void {
    this.capture.append(chunk);
  }

  teeDroppedBytes(): number {
    return 0;
  }

  flush(_timeoutMs: number): Promise<void> {
    this.flushTimeouts.push(_timeoutMs);
    return Promise.resolve();
  }
}

interface RunStubs {
  readonly child: StubChild;
  readonly recorded: Recorded;
  readonly deps: Partial<RunHostStartDeps>;
}

const TERMINAL_WRITER_EXIT_CASES: ReadonlyArray<
  readonly [string, number | null, NodeJS.Signals | null, number]
> = [
  ["clean exit", 0, null, 0],
  ["crash exit", 7, null, 7],
  ["signal exit", null, "SIGTERM", 143],
];

function makeRunStubs(
  installRecord: HostInstallRecord | null,
  existsOverride: ((path: string) => boolean) | null,
): RunStubs {
  const child = makeStubChild();
  const recorded: Recorded = {
    markers: [],
    errors: [],
    exited: null,
    exitWaiters: [],
    spawnCalls: [],
    rotations: [],
    sequence: [],
    preparedCrashReportDirs: [],
    prepareCrashReportsReturn: [],
    findCrashReportCalls: [],
    findCrashReportResult: null,
    findCrashReportHangs: false,
    findCrashReportRejects: false,
    lastStderrTee: null,
    stderrTees: [],
    loggerErrors: [],
  };
  // The stub implements only the surface `runHostStart` touches; route it
  // to `ChildProcess` through an explicit `unknown` intermediate rather than a
  // chained `as unknown as` assertion.
  const childAsUnknown: unknown = child;
  const childAsProcess: ChildProcess = childAsUnknown as ChildProcess;
  const spyLogger: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message, fields, _error) => {
      recorded.loggerErrors.push({
        message,
        fields: { ...fields },
      });
    },
  };
  const deps: Partial<RunHostStartDeps> = {
    // `runHostStart` falls back to the REAL `createCliLogger` (writing to
    // the actual production `~/.traycer/cli/cli.log`) via `deps.logger ??
    // createCliLogger(...)` whenever this is left unset - `??` treats
    // `undefined` as nullish just like a missing key, so it must be
    // supplied explicitly here, not left to the `Partial` default.
    // Spy wraps noop for crash-diagnostics message assertions.
    logger: spyLogger,
    // Same hazard as `logger` above: left unset, the `Partial` default falls
    // through to the REAL `findLiveIncumbentHost`, which reads the developer's
    // actual `~/.traycer/host/pid.json` and probes whatever host is live on
    // this machine. Every test below would then decline instead of spawning.
    findIncumbentHost: async () => null,
    // Same hazard class as `findIncumbentHost` above, now for the relaunch
    // loop:
    //   - unset, `hasStopIntent` falls through to the real implementation and
    //     reads the developer's actual `~/.traycer/host/stop-intent.json`, so a
    //     stray file left by a real `traycer host stop` would silently suppress
    //     every relaunch assertion below;
    //   - unset, `sleep` is a REAL timer, and one exhausted budget costs
    //     1+5+15+30+60 = 111s of wall clock, which no 10s test timeout
    //     survives.
    hasStopIntent: async () => false,
    // Same hazard as `hasStopIntent` above, and easier to miss because it is
    // read ONCE at startup rather than per attempt: unset, the `Partial`
    // default falls through to the real `readStopIntentIdentity`, which reads
    // the developer's actual `~/.traycer/host/stop-intent.json`. A stray record
    // from a real `traycer host stop` would then be remembered as "served at
    // startup", silently changing what every intent assertion below means.
    readStopIntentIdentity: async () => null,
    sleep: async () => undefined,
    closeLogFd: async () => undefined,
    // Pin the shared harness to a SINGLE attempt. Every test built on
    // `makeRunStubs` predates the relaunch loop and asserts what one attempt
    // records and exits with; letting them relaunch would silently change what
    // they mean. The loop has its own describe block below, which opts back in
    // with an explicit budget.
    maxRelaunches: 0,
    readLiveProbeContext: async () => ({
      kind: "unauthorised" as const,
      reason: "no-journal" as const,
    }),
    readLiveProbeContextForServiceLabel: async () => ({
      kind: "unauthorised" as const,
      reason: "no-journal" as const,
    }),
    readInstallRecord: async () => installRecord,
    pathExists: async (p: string) =>
      (existsOverride ?? ((q: string) => q === installRecord?.executablePath))(
        p,
      ),
    spawn: (command, args, options) => {
      recorded.sequence.push("spawn");
      recorded.spawnCalls.push({
        command,
        args,
        cwd: typeof options.cwd === "string" ? options.cwd : undefined,
        env: (options.env ?? {}) as Record<string, string | undefined>,
        stdio: options.stdio,
        windowsHide: options.windowsHide,
      });
      return childAsProcess;
    },
    openLogFd: async () => {
      recorded.sequence.push("open-fd");
      return 42;
    },
    rotateLog: async (environment) => {
      recorded.rotations.push(environment);
      recorded.sequence.push("rotate");
      return "skipped";
    },
    readEnvOverrides: async () => ({
      EXTRA_FROM_OVERRIDE: "1",
      TRAYCER_TEST_UNSET: null,
    }),
    writeMarker: async (environment, phase, fields) => {
      recorded.sequence.push(`marker:${phase}`);
      recorded.markers.push({
        environment,
        phase,
        fields: { ...fields } as Record<string, unknown>,
      });
    },
    writeTerminalMarker: (environment, phase, fields) => {
      recorded.sequence.push(`terminal-marker:${phase}`);
      recorded.markers.push({
        environment,
        phase,
        fields: { ...fields } as Record<string, unknown>,
      });
    },
    // The real supervisor calls process.exit which never returns. In
    // tests we record the requested code and resolve any pending waiter
    // so event-handler-driven exit paths surface to the test runner
    // without an uncaught throw.
    exit: (code) => {
      recorded.exited = code;
      while (recorded.exitWaiters.length > 0) {
        const waiter = recorded.exitWaiters.shift();
        if (waiter !== undefined) waiter();
      }
    },
    onError: (msg) => {
      recorded.errors.push(msg);
    },
    // Crash diagnostics: always inject so suites never touch real
    // ~/.traycer crash-reports or host.log tee paths.
    prepareCrashReportsDir: async (dir) => {
      recorded.preparedCrashReportDirs.push(dir);
      return recorded.prepareCrashReportsReturn;
    },
    findCrashReport: async (dir, sinceMs, excludeNames) => {
      recorded.findCrashReportCalls.push({
        dir,
        sinceMs,
        excludeNames: new Set(excludeNames),
      });
      if (recorded.findCrashReportRejects) {
        throw new Error("injected findCrashReport failure");
      }
      if (recorded.findCrashReportHangs) {
        return new Promise<CrashReportMatch | null>(() => {
          // Never resolves — exercises the scan timeout race.
        });
      }
      return recorded.findCrashReportResult;
    },
    createStderrTee: (_environment: Environment): StderrTee => {
      const tee = new MemoryStderrTee();
      recorded.lastStderrTee = tee;
      recorded.stderrTees.push(tee);
      return tee;
    },
  };
  return { child, recorded, deps };
}

async function runUntilExit(
  invoke: () => Promise<void>,
  recorded: Recorded,
): Promise<void> {
  await invoke();
  if (recorded.exited === null) {
    // Wait for an async event-handler-driven exit (child 'exit'). The
    // stub `exit` resolves any pending waiter when called.
    await new Promise<void>((resolve) => {
      recorded.exitWaiters.push(resolve);
    });
  }
  expect(recorded.exited).not.toBeNull();
}

/**
 * Schedule the stub child's terminal event AFTER spawn returns so the
 * supervisor has already attached its `exit` / `error` listeners.
 *
 * A plain `setTimeout(..., 0)` before `runHostStart` races the pre-spawn
 * awaits (`rotateLog`, `pruneCrashReports`, marker write, open fd). When
 * those take longer than a timer tick the exit event is lost and the test
 * hangs on `runUntilExit`. Emitting from a `setImmediate` nested inside
 * `spawn` always runs after the listener registration that follows spawn.
 */
function withChildExit(
  deps: Partial<RunHostStartDeps>,
  child: StubChild,
  code: number | null,
  signal: NodeJS.Signals | null,
): Partial<RunHostStartDeps> {
  const originalSpawn = deps.spawn;
  if (originalSpawn === undefined) {
    throw new Error("test spawn dependency missing");
  }
  return {
    ...deps,
    spawn: (command, args, options) => {
      const spawned = originalSpawn(command, args, options);
      setImmediate(() => {
        child.emit("exit", code, signal);
      });
      return spawned;
    },
  };
}

/**
 * One host per data dir.
 *
 * launchd runs at most one instance of a LABEL, but the CLI label
 * (`ai.traycer.host`) and Desktop's SMAppService agent label
 * (`ai.traycer.host.agent`) are distinct labels that both invoke this
 * supervisor against the same data dir, both with `RunAtLoad`. A machine
 * carrying both registrations spawned two hosts at every login, racing the
 * same pid.json and stores.
 */
describe("runHostStart - incumbent host guard", () => {
  it("declines with exit 0 and never spawns when a live host owns the data dir", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const guarded: Partial<RunHostStartDeps> = {
      ...deps,
      findIncumbentHost: async () => ({
        pid: 40769,
        version: "1.1.8",
        websocketUrl: "ws://127.0.0.1:58036/rpc",
      }),
    };

    await runHostStart({ environment: "production", cwd: null }, guarded);

    expect(recorded.spawnCalls).toHaveLength(0);
    // Exit 0 is load-bearing: the macOS plists set
    // `KeepAlive.SuccessfulExit = false`, so a clean exit leaves the job
    // down. Any non-zero code would have launchd relaunch this supervisor
    // immediately and flap against the incumbent forever.
    expect(recorded.exited).toBe(0);
    // Declining is not a spawn attempt - it must not look like one in the
    // bootstrap markers doctor/host-status read.
    expect(recorded.markers).toHaveLength(0);
  });

  it("spawns normally when no live host owns the data dir", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);

    const invoke = () =>
      runHostStart(
        { environment: "production", cwd: null },
        withChildExit(deps, child, 0, null),
      );
    await runUntilExit(invoke, recorded);

    expect(recorded.spawnCalls).toHaveLength(1);
  });

  // A live incumbent settles what this invocation should do regardless of
  // whether THIS label can resolve its own install target. Resolving first
  // exited 69, which `KeepAlive.SuccessfulExit = false` treats as
  // restartable, so launchd relaunched the job into a throttled crash loop
  // while a healthy host was serving. Reachable whenever the record breaks
  // after the incumbent came up: uninstall, failed install, or the window
  // where `host install` has swapped `install/` aside.
  it("declines with exit 0 when a host owns the data dir even if the install record is broken", async () => {
    const { recorded, deps } = makeRunStubs(null, null);
    const guarded: Partial<RunHostStartDeps> = {
      ...deps,
      findIncumbentHost: async () => ({
        pid: 40769,
        version: "1.1.8",
        websocketUrl: "ws://127.0.0.1:58036/rpc",
      }),
    };

    await runHostStart({ environment: "production", cwd: null }, guarded);

    expect(recorded.exited).toBe(0);
    expect(recorded.spawnCalls).toHaveLength(0);
    // Not a spawn attempt, so no failed-to-spawn marker either.
    expect(recorded.markers).toHaveLength(0);
  });

  it("still surfaces the install-record error when no host owns the data dir", async () => {
    const { recorded, deps } = makeRunStubs(null, null);

    await runHostStart({ environment: "production", cwd: null }, deps);

    expect(recorded.exited).toBe(69);
    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.markers.map((m) => m.phase)).toContain("failed-to-spawn");
  });
});

describe("runHostStart - label-derived reclaim probe", () => {
  it("derives live probe authority from a label-only registration and bypasses the incumbent guard", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const status = new PassThrough();
    Object.assign(child, { stdio: [null, null, null, status] });
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined)
      throw new Error("test spawn dependency missing");

    const invoke = () =>
      runHostStart(
        {
          environment: "production",
          cwd: null,
          serviceLabel: "ai.traycer.host.fallback",
        },
        {
          ...deps,
          findIncumbentHost: async () => ({
            pid: 9001,
            version: "1.0.0",
            websocketUrl: "ws://127.0.0.1:9001/rpc",
          }),
          readLiveProbeContextForServiceLabel: async () => ({
            kind: "authorised" as const,
            context: {
              transitionId: "transition-1",
              probeNonce: "nonce-1",
              serviceLabel: "ai.traycer.host.fallback",
            },
          }),
          spawn: (command, args, options) => {
            const spawned = originalSpawn(command, args, options);
            setImmediate(() => {
              status.end();
              child.emit("exit", 0, null);
            });
            return spawned;
          },
        },
      );

    await runUntilExit(invoke, recorded);
    expect(recorded.spawnCalls).toHaveLength(1);
    // stdout stays on the log fd; stderr is piped for the crash-tail tee;
    // probe status pipe remains index 3 (LAYER0_STATUS_FD).
    expect(recorded.spawnCalls[0]?.stdio).toEqual([
      "ignore",
      42,
      "pipe",
      "pipe",
    ]);

    // The status transport is authorised EXPLICITLY, never inferred. The
    // supervisor opened the pipe at stdio[3], so it must also name that
    // descriptor - and the two must agree, or the host writes its frame into
    // a descriptor nobody is reading (or, worse, one somebody else is).
    const args = recorded.spawnCalls[0]?.args ?? [];
    const flagAt = args.indexOf("--layer0-status-fd");
    expect(flagAt).toBeGreaterThanOrEqual(0);
    expect(args[flagAt + 1]).toBe("3");
    const stdio = recorded.spawnCalls[0]?.stdio;
    expect(Array.isArray(stdio) ? stdio[Number(args[flagAt + 1])] : null).toBe(
      "pipe",
    );
  });

  it("keeps a label-only start behind the incumbent guard without a live reclaim journal", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);

    await runHostStart(
      {
        environment: "production",
        cwd: null,
        serviceLabel: "ai.traycer.host.fallback",
      },
      {
        ...deps,
        readLiveProbeContextForServiceLabel: async () => ({
          kind: "unauthorised" as const,
          reason: "no-journal" as const,
        }),
        findIncumbentHost: async () => ({
          pid: 9001,
          version: "1.0.0",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
        }),
      },
    );

    expect(recorded.exited).toBe(0);
    expect(recorded.spawnCalls).toHaveLength(0);
  });

  it("writes an attested terminal probe marker for a known target-resolution failure", async () => {
    const markerWrites: unknown[] = [];
    const { recorded, deps } = makeRunStubs(null, null);

    await runHostStart(
      {
        environment: "production",
        cwd: null,
        serviceLabel: "ai.traycer.host.fallback",
      },
      {
        ...deps,
        readLiveProbeContextForServiceLabel: async () => ({
          kind: "authorised" as const,
          context: {
            transitionId: "transition-1",
            probeNonce: "nonce-1",
            serviceLabel: "ai.traycer.host.fallback",
          },
        }),
        attestProbeSupervisor: async (serviceLabel, supervisorPid) => ({
          serviceLabel,
          supervisorPid,
          capturedAt: "2026-07-27T00:00:00.000Z",
        }),
        writeProbeMarker: async (_environment, marker) => {
          markerWrites.push(marker);
        },
      },
    );

    expect(recorded.exited).toBe(69);
    expect(markerWrites).toHaveLength(1);
    expect(markerWrites[0]).toMatchObject({
      transitionId: "transition-1",
      outcome: {
        kind: "terminal",
        reason: "target-resolution-E_HOST_NOT_INSTALLED",
      },
    });
  });

  it("turns an asynchronous child spawn error into one attested terminal marker", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const markerWrites: ProbeMarker[] = [];
    const status = new PassThrough();
    Object.assign(child, { stdio: [null, null, null, status] });
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }

    const invoke = () =>
      runHostStart(
        {
          environment: "production",
          cwd: null,
          serviceLabel: "ai.traycer.host.fallback",
        },
        {
          ...deps,
          readLiveProbeContextForServiceLabel: async () => ({
            kind: "authorised" as const,
            context: {
              transitionId: "transition-async-spawn-error",
              probeNonce: "nonce-1",
              serviceLabel: "ai.traycer.host.fallback",
            },
          }),
          attestProbeSupervisor: async (serviceLabel, supervisorPid) => ({
            serviceLabel,
            supervisorPid,
            capturedAt: "2026-07-27T00:00:00.000Z",
          }),
          writeProbeMarker: async (_environment, marker) => {
            markerWrites.push(marker);
          },
          spawn: (command, args, options) => {
            const spawned = originalSpawn(command, args, options);
            setImmediate(() => {
              status.end();
              child.emit("error", new Error("ENOENT async"));
              child.emit("exit", 66, null);
            });
            return spawned;
          },
        },
      );

    await runUntilExit(invoke, recorded);

    expect(recorded.exited).toBe(66);
    expect(recorded.markers.map((marker) => marker.phase)).toContain(
      "failed-to-spawn",
    );
    expect(markerWrites).toEqual([
      expect.objectContaining({
        transitionId: "transition-async-spawn-error",
        outcome: { kind: "terminal", reason: "host-spawn-failed" },
      }),
    ]);
  });
});

describe("runHostStart - installed-record launch path", () => {
  it("spawns record.executablePath directly with no shell wrapping and the environment env exported", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const previousUnsetValue = process.env.TRAYCER_TEST_UNSET;
    process.env.TRAYCER_TEST_UNSET = "inherited";

    const invoke = () =>
      runHostStart(
        { environment: "production", cwd: null },
        withChildExit(deps, child, 0, null),
      );

    // Exit is scheduled from inside spawn (after listeners attach) so the
    // pre-spawn awaits cannot race the terminal event away.
    try {
      await runUntilExit(invoke, recorded);
    } finally {
      if (previousUnsetValue === undefined) {
        delete process.env.TRAYCER_TEST_UNSET;
      } else {
        process.env.TRAYCER_TEST_UNSET = previousUnsetValue;
      }
    }

    expect(recorded.spawnCalls).toHaveLength(1);
    const call = recorded.spawnCalls[0];
    expect(call?.command).toBe(exec);
    // The supervisor passes the slot dir as `--host-data-dir` (NOT an
    // `--environment` arg or env): path-only, so the host writes pid.json in
    // this environment's slot while its cloud target stays baked.
    expect(call?.args.slice(0, 2)).toEqual([
      "--host-data-dir",
      hostHomeDir("production"),
    ]);
    expect(call?.args[2]).toBe("--layer0-attempt-id");
    expect(call?.args[3]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // No status pipe was opened on this path, so the host must NOT be
    // authorised to write status frames. The flag IS the authorisation:
    // passing it speculatively is what let the host sniff fd 3 by type and
    // inject frames into an unrelated Node IPC channel.
    expect(call?.args).not.toContain("--layer0-status-fd");
    expect(call?.stdio).toEqual([
      "ignore",
      expect.anything(),
      expect.anything(),
    ]);
    expect(call?.env.TRAYCER_CHANNEL).toBeUndefined();
    expect(call?.env.EXTRA_FROM_OVERRIDE).toBe("1");
    expect(call?.env.TRAYCER_TEST_UNSET).toBeUndefined();
    expect(call?.env.TERM_PROGRAM).toBe("traycer");
    expect(call?.windowsHide).toBe(process.platform === "win32");
    // Production launch must NOT route through a shell - the spawn
    // command must be the executable itself.
    expect(call?.command.endsWith("/sh")).toBe(false);
    expect(call?.command).not.toContain("zsh");

    // Bootstrap markers: starting → exited (exit code 0).
    const phases = recorded.markers.map((m) => m.phase);
    expect(phases[0]).toBe("starting");
    expect(phases[phases.length - 1]).toBe("exited");
    // Marker is written under the requested environment.
    expect(recorded.markers[0]?.environment).toBe("production");
    expect(recorded.exited).toBe(0);
  });

  it("writes bootstrap markers under the dev environment and passes no environment arg", async () => {
    const exec = "/opt/traycer/host/dev/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () =>
      runHostStart(
        { environment: "dev", cwd: null },
        withChildExit(deps, child, 0, null),
      );
    await runUntilExit(invoke, recorded);
    expect(recorded.markers.every((m) => m.environment === "dev")).toBe(true);
    expect(recorded.spawnCalls[0]?.args.slice(0, 2)).toEqual([
      "--host-data-dir",
      hostHomeDir("dev"),
    ]);
    expect(recorded.spawnCalls[0]?.args[2]).toBe("--layer0-attempt-id");
    expect(recorded.spawnCalls[0]?.env.TRAYCER_CHANNEL).toBeUndefined();
  });

  it("rotates the log for this environment before anything appends to the run", async () => {
    const exec = "/opt/traycer/host/dev/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () =>
      runHostStart(
        { environment: "dev", cwd: null },
        withChildExit(deps, child, 0, null),
      );
    await runUntilExit(invoke, recorded);

    expect(recorded.rotations).toEqual(["dev"]);
    // Ordering is load-bearing, not incidental, so assert the actual SEQUENCE
    // rather than just that each step ran. The `starting` marker must land in
    // the POST-rotation file, and the stdio fd opened after it lives for the
    // child's whole lifetime - an fd follows the inode across a rename, so
    // rotating any later would divert the host's own stdout into the
    // rotated-away file and split one session across two inodes.
    // Prefix, not the whole trace: the child's own exit appends `marker:exited`
    // afterwards, which is not part of the start sequence under test.
    expect(recorded.sequence.slice(0, 4)).toEqual([
      "rotate",
      "marker:starting",
      "open-fd",
      "spawn",
    ]);
  });

  it("passes the dev-desktop run host root to the host when a slot is set", async () => {
    await withDevDesktopSlot("Worktree Slot", async () => {
      const exec = "/opt/traycer/host/dev/install/traycer-host";
      const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      const invoke = () =>
        runHostStart(
          { environment: "dev", cwd: null },
          withChildExit(deps, child, 0, null),
        );
      await runUntilExit(invoke, recorded);
      expect(recorded.spawnCalls[0]?.args.slice(0, 2)).toEqual([
        "--host-data-dir",
        hostHomeDir("dev"),
      ]);
      expect(recorded.spawnCalls[0]?.args[2]).toBe("--layer0-attempt-id");
      expect(hostHomeDir("dev")).toMatch(
        /[\\/]\.traycer[\\/]host[\\/]dev-runs[\\/]worktree-slot$/,
      );
    });
  });

  it("dev wrapper-script executablePath spawns through the same code path", async () => {
    // The dev orchestrator stages a small POSIX wrapper at
    // `~/.traycer/host/dev/runtime/traycer-host` that internally
    // exec's `node <bundle>`. The supervisor sees only the wrapper
    // path - it does NOT branch on bundle / node-bin args anymore.
    const wrapper = "/Users/dev/.traycer/host/dev/runtime/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(wrapper), null);
    const invoke = () =>
      runHostStart(
        { environment: "dev", cwd: null },
        withChildExit(deps, child, 0, null),
      );
    await runUntilExit(invoke, recorded);
    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.spawnCalls[0]?.command).toBe(wrapper);
    expect(recorded.spawnCalls[0]?.args.slice(0, 2)).toEqual([
      "--host-data-dir",
      hostHomeDir("dev"),
    ]);
    expect(recorded.spawnCalls[0]?.args[2]).toBe("--layer0-attempt-id");
  });
});

describe("runHostStart - error surfaces", () => {
  it("missing install record: writes failed-to-spawn marker and exits with HOST_NOT_INSTALLED", async () => {
    const { recorded, deps } = makeRunStubs(null, null);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    await runUntilExit(invoke, recorded);
    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(69);
    const errLine = recorded.errors.join("\n");
    expect(errLine).toContain(CLI_ERROR_CODES.HOST_NOT_INSTALLED);
    // Marker carries the structured code so `host status` can surface
    // the failure on a fresh machine where the supervisor never spun up.
    const failedMarker = recorded.markers.find(
      (m) => m.phase === "failed-to-spawn",
    );
    expect(failedMarker).toBeDefined();
    expect(failedMarker?.fields.error).toContain(
      CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    );
  });

  it("install record present but executable missing: exits with HOST_NOT_INSTALLED carrying the bad path", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), () => false);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(69);
    expect(recorded.errors.join("\n")).toContain(exec);
  });

  it("install record with empty executablePath: exits with HOST_INSTALL_RECORD_INVALID", async () => {
    const { recorded, deps } = makeRunStubs(sampleRecord(""), null);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(1);
    expect(recorded.errors.join("\n")).toContain(
      CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    );
  });
});

describe("runHostStart - signal/exit propagation", () => {
  it("persists a terminal marker before synchronous exit when an async append would be abandoned", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    let exited = false;
    const terminalMarkers: string[] = [];
    const durabilityDeps: Partial<RunHostStartDeps> = {
      ...deps,
      writeMarker: async (environment, phase, fields) => {
        if (phase === "starting") {
          recorded.markers.push({
            environment,
            phase,
            fields: { ...fields } as Record<string, unknown>,
          });
          return;
        }
        // Models an async append that cannot commit after process.exit().
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        if (!exited) terminalMarkers.push(phase);
      },
      writeTerminalMarker: (_environment, phase) => {
        expect(exited).toBe(false);
        terminalMarkers.push(phase);
      },
      exit: (code) => {
        exited = true;
        recorded.exited = code;
        while (recorded.exitWaiters.length > 0) {
          const waiter = recorded.exitWaiters.shift();
          if (waiter !== undefined) waiter();
        }
      },
    };

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          withChildExit(durabilityDeps, child, 7, null),
        ),
      recorded,
    );

    expect(terminalMarkers).toEqual(["crashed"]);
  });

  it("translates a SIGTERM-killed child into exit code 128+15", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () =>
      runHostStart(
        { environment: "production", cwd: null },
        withChildExit(deps, child, null, "SIGTERM"),
      );
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(143);
    const killed = recorded.markers.find((m) => m.phase === "killed");
    expect(killed?.fields.signal).toBe("SIGTERM");
  });

  it.each(TERMINAL_WRITER_EXIT_CASES)(
    "preserves the original %s code when the synchronous terminal writer throws",
    async (
      _name,
      code: number | null,
      signal: NodeJS.Signals | null,
      expected,
    ) => {
      const exec = "/opt/traycer/host/install/traycer-host";
      const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      const throwingWriter: Partial<RunHostStartDeps> = {
        ...deps,
        writeTerminalMarker: () => {
          throw new Error("disk full");
        },
      };

      await runUntilExit(
        () =>
          runHostStart(
            { environment: "production", cwd: null },
            withChildExit(throwingWriter, child, code, signal),
          ),
        recorded,
      );

      expect(recorded.exited).toBe(expected);
    },
  );

  it("propagates a non-zero exit code as a `crashed` marker", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () =>
      runHostStart(
        { environment: "production", cwd: null },
        withChildExit(deps, child, 7, null),
      );
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed?.fields.exitCode).toBe(7);
  });

  it("enriches a crashed marker with exitMeaning, report, and stderrTail via injected deps", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const stderr = new PassThrough();
    Object.assign(child, { stderr });

    // Pre-existing names returned by prepare — must be passed through to the scan.
    recorded.prepareCrashReportsReturn = [
      "report.prev-child.json",
      "report.older.json",
    ];
    recorded.findCrashReportResult = {
      filename: "report.oom.json",
      summary: "event=Allocation failed trigger=FatalError",
    };

    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    const beforeSpawnMs = Date.now();
    const enrichedDeps: Partial<RunHostStartDeps> = {
      ...deps,
      spawn: (command, args, options) => {
        const spawned = originalSpawn(command, args, options);
        setImmediate(() => {
          stderr.write(
            Buffer.from(
              "FATAL ERROR: Reached heap limit\nAllocation failed - JavaScript heap out of memory\n",
            ),
          );
          stderr.end();
          // NTSTATUS fail-fast (Windows 0xC0000409) as a positive decimal.
          child.emit("exit", 3221226505, null);
        });
        return spawned;
      },
    };

    await runUntilExit(
      () =>
        runHostStart({ environment: "production", cwd: null }, enrichedDeps),
      recorded,
    );

    expect(recorded.exited).toBe(3221226505);
    // Crash-reports dir is prepared under the child cwd (host home for production).
    expect(recorded.preparedCrashReportDirs).toEqual([
      join(hostHomeDir("production"), "crash-reports"),
    ]);
    // Scan uses spawn time minus slack AND the pre-existing exclude set.
    expect(recorded.findCrashReportCalls).toHaveLength(1);
    const call = recorded.findCrashReportCalls[0]!;
    expect(call.dir).toBe(join(hostHomeDir("production"), "crash-reports"));
    expect(call.sinceMs).toBeGreaterThanOrEqual(
      beforeSpawnMs - CRASH_REPORT_SPAWN_SLACK_MS - 50,
    );
    expect(call.sinceMs).toBeLessThanOrEqual(
      Date.now() - CRASH_REPORT_SPAWN_SLACK_MS + 50,
    );
    expect([...call.excludeNames].sort()).toEqual([
      "report.older.json",
      "report.prev-child.json",
    ]);

    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed).toBeDefined();
    expect(crashed?.fields.exitCode).toBe(3221226505);
    expect(String(crashed?.fields.exitMeaning)).toContain("0xC0000409");
    expect(String(crashed?.fields.exitMeaning)).toContain(
      "STATUS_STACK_BUFFER_OVERRUN",
    );
    expect(crashed?.fields.report).toBe("report.oom.json");
    expect(String(crashed?.fields.stderrTail)).toContain("FATAL ERROR");
    expect(String(crashed?.fields.stderrTail)).toContain("\\n");
  });

  it("enriches a killed+SIGABRT marker, logs Host crash diagnostics, and leaves SIGTERM bare", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const sigabrtNum = osConstants.signals.SIGABRT;
    expect(typeof sigabrtNum).toBe("number");
    const expectedAbrtExit = 128 + (sigabrtNum as number);

    {
      const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      const stderr = new PassThrough();
      Object.assign(child, { stderr });
      recorded.prepareCrashReportsReturn = ["report.preexisting.json"];
      recorded.findCrashReportResult = {
        filename: "report.abrt.json",
        summary: "event=FatalError",
      };
      const originalSpawn = deps.spawn;
      if (originalSpawn === undefined) {
        throw new Error("test spawn dependency missing");
      }
      await runUntilExit(
        () =>
          runHostStart(
            { environment: "production", cwd: null },
            {
              ...deps,
              spawn: (command, args, options) => {
                const spawned = originalSpawn(command, args, options);
                setImmediate(() => {
                  stderr.write(Buffer.from("abort: OOM\n"));
                  stderr.end();
                  child.emit("exit", null, "SIGABRT");
                });
                return spawned;
              },
            },
          ),
        recorded,
      );
      // Platform-correct signal number (macOS/Linux SIGABRT → 134).
      expect(recorded.exited).toBe(expectedAbrtExit);
      const killed = recorded.markers.find((m) => m.phase === "killed");
      expect(killed?.fields.signal).toBe("SIGABRT");
      expect(String(killed?.fields.exitMeaning)).toContain("SIGABRT");
      expect(killed?.fields.report).toBe("report.abrt.json");
      expect(String(killed?.fields.stderrTail)).toContain("abort");
      expect(recorded.findCrashReportCalls).toHaveLength(1);
      expect([...recorded.findCrashReportCalls[0]!.excludeNames]).toEqual([
        "report.preexisting.json",
      ]);
      // Same support-log line as the nonzero-exit crash branch.
      const diag = recorded.loggerErrors.find(
        (e) => e.message === "Host crash diagnostics",
      );
      expect(diag).toBeDefined();
      expect(String(diag?.fields.exitMeaning)).toContain("SIGABRT");
      expect(diag?.fields.report).toBe("report.abrt.json");
    }

    {
      const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      await runUntilExit(
        () =>
          runHostStart(
            { environment: "production", cwd: null },
            withChildExit(deps, child, null, "SIGTERM"),
          ),
        recorded,
      );
      const killed = recorded.markers.find((m) => m.phase === "killed");
      expect(killed?.fields.signal).toBe("SIGTERM");
      expect(killed?.fields.exitMeaning).toBeUndefined();
      expect(killed?.fields.report).toBeUndefined();
      expect(killed?.fields.stderrTail).toBeUndefined();
      // Forwarded shutdown signals must not scan for a crash report.
      expect(recorded.findCrashReportCalls).toHaveLength(0);
      expect(
        recorded.loggerErrors.some(
          (e) => e.message === "Host crash diagnostics",
        ),
      ).toBe(false);
    }
  });

  it("writes a crashed marker without report when findCrashReport never resolves", async () => {
    // Production races the scan against CRASH_REPORT_SCAN_TIMEOUT_MS (2s).
    // A hanging findCrashReport must not block the terminal marker.
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    recorded.findCrashReportHangs = true;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          withChildExit(deps, child, 7, null),
        ),
      recorded,
    );

    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed).toBeDefined();
    expect(crashed?.fields.exitCode).toBe(7);
    expect(crashed?.fields.report).toBeUndefined();
  }, 10_000);

  it("writes the terminal marker and exits when findCrashReport rejects", async () => {
    // Injected findCrashReport must not skip marker + deps.exit (the race
    // has a .catch; without it a rejection leaves the supervisor alive).
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    recorded.findCrashReportRejects = true;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          withChildExit(deps, child, 7, null),
        ),
      recorded,
    );

    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed).toBeDefined();
    expect(crashed?.fields.exitCode).toBe(7);
    expect(crashed?.fields.report).toBeUndefined();
  });

  it("survives an error on the stderr stream and still writes the terminal marker", async () => {
    // Major: an unhandled Readable error on child.stderr used to kill the
    // supervisor before persistChildExit wrote the marker Desktop reads.
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const stderr = new PassThrough();
    Object.assign(child, { stderr });
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            spawn: (command, args, options) => {
              const spawned = originalSpawn(command, args, options);
              setImmediate(() => {
                stderr.write(Buffer.from("partial fatal text\n"));
                // Stream error instead of a clean end — must be swallowed.
                stderr.emit("error", new Error("EIO on host stderr"));
                child.emit("exit", 7, null);
              });
              return spawned;
            },
          },
        ),
      recorded,
    );

    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed).toBeDefined();
    expect(crashed?.fields.exitCode).toBe(7);
    // Bytes that arrived before the error are still worth recording.
    expect(String(crashed?.fields.stderrTail)).toContain("partial fatal text");
  });

  it("includes stderr bytes that arrive after exit but before stream end", async () => {
    // Major: `exit` ≠ drained pipe. Without awaiting stderrEnded before the
    // marker, the fatal text still in the pipe is lost. This test FAILS if
    // that await is removed.
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const stderr = new PassThrough();
    Object.assign(child, { stderr });
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            spawn: (command, args, options) => {
              const spawned = originalSpawn(command, args, options);
              setImmediate(() => {
                // Process dies first; fatal text is still in flight.
                child.emit("exit", 7, null);
                setImmediate(() => {
                  stderr.write(
                    Buffer.from(
                      "FATAL ERROR: late-arriving OOM block after exit\n",
                    ),
                  );
                  stderr.end();
                });
              });
              return spawned;
            },
          },
        ),
      recorded,
    );

    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed).toBeDefined();
    expect(String(crashed?.fields.stderrTail)).toContain(
      "FATAL ERROR: late-arriving OOM block after exit",
    );
  });

  it("writes the marker within the stderr-end deadline when the stream never ends", async () => {
    // A grandchild holding the inherited stderr fd can delay close forever;
    // the wait is bounded so the supervisor cannot hang on exit.
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const stderr = new PassThrough();
    Object.assign(child, { stderr });
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }

    const started = Date.now();
    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            spawn: (command, args, options) => {
              const spawned = originalSpawn(command, args, options);
              setImmediate(() => {
                stderr.write(Buffer.from("partial\n"));
                // Never end/close — only exit.
                child.emit("exit", 7, null);
              });
              return spawned;
            },
          },
        ),
      recorded,
    );
    const elapsed = Date.now() - started;

    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed).toBeDefined();
    // Bound: wait is STDERR_END_WAIT_TIMEOUT_MS, not forever.
    expect(elapsed).toBeLessThan(STDERR_END_WAIT_TIMEOUT_MS + 1_500);
    expect(elapsed).toBeGreaterThanOrEqual(STDERR_END_WAIT_TIMEOUT_MS - 200);
  }, 10_000);

  it("omits crash-diagnostic fields on clean exit", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          withChildExit(deps, child, 0, null),
        ),
      recorded,
    );
    const exited = recorded.markers.find((m) => m.phase === "exited");
    expect(exited?.fields.exitMeaning).toBeUndefined();
    expect(exited?.fields.report).toBeUndefined();
    expect(exited?.fields.stderrTail).toBeUndefined();
    expect(recorded.findCrashReportCalls).toHaveLength(0);
  });

  it("spawn() throw is translated into HOST_SPAWN_FAILED + exit 66", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const failingSpawn: Partial<RunHostStartDeps> = {
      ...deps,
      spawn: () => {
        throw new Error("ENOENT exec missing");
      },
    };
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, failingSpawn);
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(66);
    expect(recorded.errors.join("\n")).toContain(
      CLI_ERROR_CODES.HOST_SPAWN_FAILED,
    );
  });
});

describe("HostStartTarget", () => {
  it("returns the --host-data-dir slot arg and the install record on the only supported path", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const target: HostStartTarget = await resolveHostStartTarget(
      { environment: "production", cwd: null },
      {
        readInstallRecord: async () => sampleRecord(exec),
        pathExists: () => Promise.resolve(true),
      },
    );
    expect(target.args).toEqual(["--host-data-dir", hostHomeDir("production")]);
    expect(target.record.version).toBe("1.0.0");
  });
});

// --------------------------------- service manifest sanity tests
//
// SCOPE. These are text-level negatives about the manifest layer only: that
// no flag which does not exist on `host start` leaks into a generated
// definition. They deliberately do NOT try to assert the identity binding
// works - substring assertions here were proven vacuous during cold review
// (`expect(unit).toContain("--service-label")` passed with the label branch
// stripped, because the string also appeared in the probe pattern).
//
// The binding is proven by EXECUTING the emitted artifact:
//   * macOS      - service/platforms/__tests__/macos.test.ts
//   * systemd    - service/platforms/__tests__/linux.test.ts
//   * Windows    - service/platforms/__tests__/windows-hidden-launcher.test.ts
//   * real CLI   - host/__tests__/capabilities.test.ts

describe("service manifests never leak a flag `host start` does not have", () => {
  const REMOVED_FLAGS = ["--environment", "--bundle", "--node-bin"] as const;

  it("macOS plist", async () => {
    const { buildLaunchAgentPlist } =
      await import("../../service/platforms/macos");
    const xml = buildLaunchAgentPlist({
      label: {
        id: "ai.traycer.host.prod",
        displayName: "Traycer Host",
        environment: "production",
      } as never,
      cli: {
        command: "/Users/test/.traycer/cli/bin/traycer",
        args: [],
      },
    });
    // launchd execs ProgramArguments[0]; the compatibility program is the
    // per-label launcher FILE (macOS names the login item after it - the
    // former inline `/bin/sh -c` vector surfaced as "sh" in Login Items).
    expect(xml).toContain("/ai.traycer.host.prod/traycer-host-start</string>");
    expect(xml).not.toContain("<string>/bin/sh</string>");
    for (const flag of REMOVED_FLAGS) expect(xml).not.toContain(flag);
  });

  it("systemd unit", async () => {
    const { buildSystemdUnit } = await import("../../service/platforms/linux");
    const unit = buildSystemdUnit({
      label: {
        id: "ai.traycer.host.dev",
        displayName: "Traycer Host (dev)",
        environment: "dev",
      } as never,
      cli: {
        command: "/home/test/.traycer/cli/bin/traycer",
        args: [],
      },
    });
    for (const flag of REMOVED_FLAGS) expect(unit).not.toContain(flag);
  });

  it("Windows Scheduled Task XML and its hidden launcher", async () => {
    const { buildScheduledTaskXml, buildWindowsHiddenHostLauncher } =
      await import("../../service/platforms/windows");
    const prevUsername = process.env.USERNAME;
    process.env.USERNAME = "testuser";
    const restoreUsername = () => {
      if (prevUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = prevUsername;
    };
    try {
      const cli = {
        command: "C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe",
        args: [],
      };
      const label = {
        id: "ai.traycer.host.prod",
        displayName: "Traycer Host",
        environment: "production" as const,
        devSlot: null,
      };
      const xml = buildScheduledTaskXml({ label, cli });
      const launcher = buildWindowsHiddenHostLauncher(cli, label);
      // The task must launch the GUI script host, not the console CLI, or
      // Task Scheduler flashes a window on every login.
      expect(xml).toContain("<Hidden>true</Hidden>");
      expect(xml).toContain("wscript.exe");
      expect(xml).toContain("host-start-hidden.vbs");
      expect(xml).not.toContain(
        "<Command>C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe</Command>",
      );
      for (const flag of REMOVED_FLAGS) {
        expect(`${xml}\n${launcher}`).not.toContain(flag);
      }
    } finally {
      restoreUsername();
    }
  });
});

// ---------------------------------------------------------------------------
// Crash-relaunch loop (int #4826, from OSS #916)
//
// A host that crashes while the desktop app is CLOSED had no guardian at all:
// the health monitor is not running, launch converge needs a launch, and on
// Windows the Scheduled Task did not restart a task whose action exited
// 0xC0000409. The supervisor now relaunches its own child.
//
// The tests that assert an ABSENCE of relaunch matter most, because that is
// where this feature can do damage (resurrecting a host the user stopped). They
// are written so they cannot pass vacuously: the spawn seam counts calls, so a
// mechanism that never ran at all fails just as loudly as one that ran twice.
// ---------------------------------------------------------------------------

/**
 * Drive N attempts whose child outcome is scripted per attempt.
 *
 * `outcomes[i]` is applied to the i-th spawn; the last entry repeats, so a
 * "crashes forever" host is `[{ code: 7 }]`. Emitting from inside `spawn`
 * (rather than a timer) guarantees the supervisor has attached its listeners,
 * which is the same reason `withChildExit` does it that way.
 */
function withScriptedAttempts(
  deps: Partial<RunHostStartDeps>,
  outcomes: ReadonlyArray<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>,
): { deps: Partial<RunHostStartDeps>; children: StubChild[] } {
  const originalSpawn = deps.spawn;
  if (originalSpawn === undefined) {
    throw new Error("test spawn dependency missing");
  }
  const children: StubChild[] = [];
  return {
    children,
    deps: {
      ...deps,
      spawn: (command, args, options) => {
        const index = children.length;
        // A FRESH child per attempt, mirroring production: reusing one emitter
        // would let a stale listener settle the next attempt's promise.
        const child = makeStubChild();
        children.push(child);
        originalSpawn(command, args, options);
        const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? {
          code: 0,
          signal: null,
        };
        setImmediate(() => {
          child.emit("exit", outcome.code, outcome.signal);
        });
        return asChildProcess(child);
      },
    },
  };
}

function withRestartAttempts(deps: Partial<RunHostStartDeps>): {
  deps: Partial<RunHostStartDeps>;
  children: StubChild[];
} {
  const originalSpawn = deps.spawn;
  if (originalSpawn === undefined) {
    throw new Error("test spawn dependency missing");
  }
  const outcomes = [
    { code: RESTART_EXIT_CODE, signal: null },
    { code: 0, signal: null },
  ] as const;
  const children: StubChild[] = [];
  return {
    children,
    deps: {
      ...deps,
      spawn: (command, args, options) => {
        const index = children.length;
        const child = makeStubChildWithStderr();
        const status = new PassThrough();
        Object.assign(child, { stdio: [null, null, null, status] });
        children.push(child);
        originalSpawn(command, args, options);
        const outcome = outcomes[index] ?? outcomes[outcomes.length - 1];
        setImmediate(() => {
          if (index === 0) {
            child.stderr?.write("first-attempt-restart-stderr\n");
          }
          status.end();
          child.stderr?.end();
          child.emit("exit", outcome.code, outcome.signal);
        });
        return asChildProcess(child);
      },
    },
  };
}

function startingAttemptIds(recorded: Recorded): string[] {
  return recorded.markers
    .filter((m) => m.phase === "starting")
    .map((m) => String(m.fields.attemptId));
}

describe("runHostStart - crash relaunch loop", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("relaunches an intentional restart immediately without budget or crash evidence", async () => {
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const sleepCalls: number[] = [];
    const probeMarkers: ProbeMarker[] = [];
    const scripted = withRestartAttempts(deps);

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host.restart-test",
          },
          {
            ...scripted.deps,
            maxRelaunches: MAX_CONSECUTIVE_RELAUNCHES,
            sleep: async (ms) => {
              sleepCalls.push(ms);
            },
            readLiveProbeContextForServiceLabel: async () => ({
              kind: "authorised" as const,
              context: {
                transitionId: "restart-transition",
                probeNonce: "restart-nonce",
                serviceLabel: "ai.traycer.host.restart-test",
              },
            }),
            readLayer0Frame: async (): Promise<Layer0FrameRead> => {
              const attemptId = recorded.markers
                .filter((marker) => marker.phase === "starting")
                .at(-1)?.fields.attemptId;
              if (typeof attemptId !== "string") {
                return { kind: "indeterminate", reason: "missing-attempt" };
              }
              return {
                kind: "frame",
                frame: { attemptId, layer0: "acquired" },
              };
            },
            attestProbeSupervisor: async (serviceLabel, supervisorPid) => ({
              serviceLabel,
              supervisorPid,
              capturedAt: "2026-08-12T00:00:00.000Z",
            }),
            writeProbeMarker: async (_environment, marker) => {
              probeMarkers.push(marker);
            },
          },
        ),
      recorded,
    );

    // Exit 87 is the host's explicit restart handshake. It must not consume
    // the crash budget or wait through crash backoff before starting again.
    expect(recorded.spawnCalls).toHaveLength(2);
    expect(sleepCalls).toEqual([]);
    expect(recorded.exited).toBe(0);
    expect(
      recorded.markers.filter((marker) => marker.phase === "crashed"),
    ).toHaveLength(0);
    expect(recorded.findCrashReportCalls).toHaveLength(0);

    const firstChild = scripted.children[0];
    expect(firstChild?.stderr?.destroyed).toBe(true);
    expect(firstChild?.stderr?.listenerCount("data")).toBe(0);
    const firstTee = recorded.stderrTees[0];
    expect(firstTee).toBeDefined();
    expect(firstTee?.flushTimeouts).toHaveLength(1);
    expect(firstTee?.capture.escapedForMarker()).toContain(
      "first-attempt-restart-stderr",
    );
    expect(probeMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: {
            kind: "terminal",
            reason: "child-exit-87",
          },
        }),
      ]),
    );
  });

  it("lets a sustained run forgive the crash budget even when it ends in a requested restart", async () => {
    // The restart branch returns to the top of the loop directly, so it never
    // reaches the sustained-uptime reset the abnormal path applies. Without
    // its own copy, a host that burned budget, then ran well past
    // `SUSTAINED_UPTIME_RESET_MS`, then was restarted ON PURPOSE would hand
    // its replacement the stale crash history that the sustained run had
    // already earned off - so an operator-requested restart quietly shortens
    // the next real crash allowance.
    //
    // `shouldAdvanceTime` because the restart path really does wait on timers
    // (the bounded stderr-end wait and tee flush). Frozen fake time never
    // fires them and the attempt never finalizes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      const originalSpawn = deps.spawn;
      if (originalSpawn === undefined) {
        throw new Error("test spawn dependency missing");
      }
      const outcomes = [
        { code: 9, signal: null },
        { code: RESTART_EXIT_CODE, signal: null },
        { code: 9, signal: null },
        { code: 0, signal: null },
      ] as const;
      let spawned = 0;

      await runUntilExit(
        () =>
          runHostStart(
            {
              environment: "production",
              cwd: null,
              serviceLabel: "ai.traycer.host.budget-test",
            },
            {
              ...deps,
              // One relaunch of budget: enough that the SECOND crash can only
              // be survived if the sustained run reset the counter.
              maxRelaunches: 1,
              sleep: async () => undefined,
              spawn: (command, args, options) => {
                const index = spawned;
                spawned += 1;
                const child = makeStubChildWithStderr();
                const status = new PassThrough();
                Object.assign(child, { stdio: [null, null, null, status] });
                originalSpawn(command, args, options);
                // `childSpawnedAtMs` is stamped before this call, so advancing
                // here is the child running. Only the restart attempt runs long.
                if (index === 1) {
                  vi.setSystemTime(
                    Date.now() + SUSTAINED_UPTIME_RESET_MS + 1_000,
                  );
                }
                const outcome =
                  outcomes[index] ?? outcomes[outcomes.length - 1];
                setImmediate(() => {
                  status.end();
                  child.stderr?.end();
                  child.emit("exit", outcome.code, outcome.signal);
                });
                return asChildProcess(child);
              },
              readLiveProbeContextForServiceLabel: async () => ({
                kind: "authorised" as const,
                context: {
                  transitionId: "budget-transition",
                  probeNonce: "budget-nonce",
                  serviceLabel: "ai.traycer.host.budget-test",
                },
              }),
              readLayer0Frame: async (): Promise<Layer0FrameRead> => {
                const attemptId = recorded.markers
                  .filter((marker) => marker.phase === "starting")
                  .at(-1)?.fields.attemptId;
                if (typeof attemptId !== "string") {
                  return { kind: "indeterminate", reason: "missing-attempt" };
                }
                return {
                  kind: "frame",
                  frame: { attemptId, layer0: "acquired" },
                };
              },
              attestProbeSupervisor: async (serviceLabel, supervisorPid) => ({
                serviceLabel,
                supervisorPid,
                capturedAt: "2026-08-12T00:00:00.000Z",
              }),
              writeProbeMarker: async () => undefined,
            },
          ),
        recorded,
      );

      // crash → sustained run ending in restart → crash → clean stand-down.
      // Carrying the stale count stops one attempt earlier, on exit 9.
      expect(recorded.spawnCalls).toHaveLength(4);
      expect(recorded.exited).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops respawning a host that requests a restart faster than it can start", async () => {
    // Exit 87 deliberately skips the crash budget AND the backoff - it is a
    // hand-off, not a failure. But "skips the budget" must not mean unbounded:
    // a host whose restart handshake fires during startup would otherwise
    // spawn / exit 87 / respawn with no delay for the supervisor's lifetime.
    // Exiting with the child's own 87 hands the decision up to the service
    // supervisor, which is the only layer that can space the attempts.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host.restart-storm",
          },
          {
            ...deps,
            maxRelaunches: MAX_CONSECUTIVE_RELAUNCHES,
            sleep: async () => undefined,
            spawn: (command, args, options) => {
              const child = makeStubChildWithStderr();
              const status = new PassThrough();
              Object.assign(child, { stdio: [null, null, null, status] });
              originalSpawn(command, args, options);
              // Never runs long enough to clear the immediate-restart floor.
              setImmediate(() => {
                status.end();
                child.stderr?.end();
                child.emit("exit", RESTART_EXIT_CODE, null);
              });
              return asChildProcess(child);
            },
            readLiveProbeContextForServiceLabel: async () => ({
              kind: "authorised" as const,
              context: {
                transitionId: "storm-transition",
                probeNonce: "storm-nonce",
                serviceLabel: "ai.traycer.host.restart-storm",
              },
            }),
            readLayer0Frame: async (): Promise<Layer0FrameRead> => {
              const attemptId = recorded.markers
                .filter((marker) => marker.phase === "starting")
                .at(-1)?.fields.attemptId;
              if (typeof attemptId !== "string") {
                return { kind: "indeterminate", reason: "missing-attempt" };
              }
              return {
                kind: "frame",
                frame: { attemptId, layer0: "acquired" },
              };
            },
            attestProbeSupervisor: async (serviceLabel, supervisorPid) => ({
              serviceLabel,
              supervisorPid,
              capturedAt: "2026-08-12T00:00:00.000Z",
            }),
            writeProbeMarker: async () => undefined,
          },
        ),
      recorded,
    );

    // Bounded, not infinite - and bounded by the RESTART cap rather than the
    // crash budget, which this path must never consume.
    expect(recorded.spawnCalls).toHaveLength(MAX_IMMEDIATE_RESTARTS);
    expect(recorded.exited).toBe(RESTART_EXIT_CODE);
    expect(
      recorded.markers.filter((marker) => marker.phase === "crashed"),
    ).toHaveLength(0);
  });

  it("does not relaunch a host that exits cleanly", async () => {
    // exit 0 is the host standing down on purpose - and is also the
    // incumbent-declined path. `KeepAlive{SuccessfulExit:false}` restated.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 0, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 5 },
        ),
      recorded,
    );

    expect(recorded.exited).toBe(0);
    // Not "no second marker" - the SPAWN seam, so a broken loop that never
    // spawned anything at all could not pass this by accident.
    expect(recorded.spawnCalls).toHaveLength(1);
  });

  it("relaunches a crashed host and gives the new attempt its own identity", async () => {
    // `spawn-evidence.ts` pairs a post-baseline `starting` marker with its
    // terminal marker. A relaunch that reused the first attempt's id would read
    // as a second ending for the first attempt.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: 7, signal: null },
      { code: 0, signal: null },
    ]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 5 },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(2);
    expect(recorded.exited).toBe(0);
    const ids = startingAttemptIds(recorded);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(recorded.markers.filter((m) => m.phase === "crashed")).toHaveLength(
      1,
    );
  });

  it("gives up after the budget and exits with the child's own code", async () => {
    // Exhaustion must hand the machine back to launchd / systemd / the next
    // logon rather than spin - and must not launder the crash code into a 0.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 9, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 2 },
        ),
      recorded,
    );

    // 1 initial + 2 relaunches.
    expect(recorded.spawnCalls).toHaveLength(3);
    expect(recorded.exited).toBe(9);
    expect(recorded.markers.filter((m) => m.phase === "crashed")).toHaveLength(
      3,
    );
  });

  it("relaunches a fatal signal death but never a forwarded shutdown signal", async () => {
    // A Node fatal abort on POSIX IS the crash, wearing a signal. A forwarded
    // SIGTERM is the opposite and must not be recovered.
    const fatal = makeRunStubs(sampleRecord(exec), null);
    const fatalScript = withScriptedAttempts(fatal.deps, [
      { code: null, signal: "SIGABRT" },
      { code: 0, signal: null },
    ]);
    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...fatalScript.deps, maxRelaunches: 5 },
        ),
      fatal.recorded,
    );
    expect(fatal.recorded.spawnCalls).toHaveLength(2);

    // The forwarded case has to actually FORWARD: the supervisor is signalled,
    // latches, and passes it on. Scripting a SIGTERM child death without
    // signalling the supervisor does not exercise this - it is the direct-kill
    // case below, and asserting "no relaunch" on it was pinning a bug.
    //
    // TWO earlier versions of this test failed to exercise it anyway. The first
    // only scripted the death. The second emitted the signal SYNCHRONOUSLY from
    // inside the spawn stub - before `deps.spawn` had returned, so
    // `currentChild` was still null and the handler forwarded nothing; the
    // child died purely because the script said so, and the test could not tell
    // the two cases apart. The signal has to arrive AFTER the spawn call
    // returns, and the child's death has to be CAUSED by the forwarded kill.
    const term = makeRunStubs(sampleRecord(exec), null);
    const termSpawn = term.deps.spawn;
    if (termSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    const forwarded: string[] = [];
    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...term.deps,
            maxRelaunches: 5,
            spawn: (command, args, options) => {
              termSpawn(command, args, options);
              const child = makeStubChild();
              // The child dies ONLY from the forwarded signal, which is what
              // makes this a forwarding test rather than a latch test.
              child.kill = (signal: NodeJS.Signals | undefined) => {
                forwarded.push(String(signal));
                setImmediate(() => {
                  child.emit("exit", null, signal ?? "SIGTERM");
                });
                return true;
              };
              setImmediate(() => {
                // `currentChild` is assigned once this spawn call returns, so
                // by now the handler has a child to forward to. The handler
                // runs synchronously inside `emit`.
                process.emit("SIGTERM");
                if (forwarded.length === 0) {
                  // Nothing forwarded: end the attempt so the assertion below
                  // reports it instead of hanging the suite.
                  child.emit("exit", null, "SIGTERM");
                }
              });
              return asChildProcess(child);
            },
          },
        ),
      term.recorded,
    );
    // The load-bearing assertion: the supervisor passed the signal on.
    expect(forwarded).toEqual(["SIGTERM"]);
    expect(term.recorded.spawnCalls).toHaveLength(1);
    // Exit 0, NOT 128+SIGTERM. This is the ordinary macOS `host stop`: launchd
    // signals the supervisor, it forwards, and the child dies by that signal.
    // Reporting 143 would be `KeepAlive{SuccessfulExit:false}`'s cue to start a
    // replacement supervisor - which reads the stop intent as predating its own
    // invocation, treats it as served, and starts the host. Not relaunching
    // in-process while telling the service manager to relaunch us is not a stop.
    expect(term.recorded.exited).toBe(0);
  });

  it("releases the signal handlers when it leaves by throwing", async () => {
    // Leaving by `throw` is still leaving. `exitSupervisor` covers the return
    // paths, but an unexpected target-resolution error rethrows - and a caller
    // that catches it would keep a stale handler set, each handler still
    // mutating the `shuttingDown` of the run that installed it.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const before = process.listenerCount("SIGTERM");

    await expect(
      runHostStart(
        { environment: "production", cwd: null },
        {
          ...deps,
          maxRelaunches: 1,
          readInstallRecord: async () => {
            throw new Error("disk on fire");
          },
        },
      ),
    ).rejects.toThrow("disk on fire");

    expect(process.listenerCount("SIGTERM") - before).toBe(0);
    expect(recorded.spawnCalls).toHaveLength(0);
  });

  it("abandons the backoff the moment a shutdown signal arrives", async () => {
    // Re-checking the latch AFTER the wait is not enough. On a CLI-owned macOS
    // host a `host restart` during a 30-60s backoff sends `launchctl kill
    // TERM`, then `stopService` waits only on the already-dead host pid and
    // proceeds to `kickstart` - which no-ops while launchd still considers
    // this supervisor running. Sit out the full sleep and the restart has
    // already no-op'd by the time the latch is read: the machine stays
    // hostless. The wait has to END, not merely be re-examined afterwards.
    //
    // The injected sleep here NEVER resolves, so only the shutdown edge can
    // complete the race. Without it this test times out rather than failing on
    // an assertion - which is the honest signal, since the production symptom
    // is also "waits when it should not".
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 7, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            sleep: () =>
              new Promise<void>(() => {
                setImmediate(() => {
                  process.emit("SIGTERM");
                });
              }),
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(1);
    // And exits 0, not the crashed child's 7 - see the exit-code describe
    // below. This scenario makes the point sharply: the restart is mid-flight,
    // so a nonzero exit here races `kickstart` with launchd's own respawn of
    // this job.
    expect(recorded.exited).toBe(0);
  });

  it("escalates a raced stop to SIGKILL when the child ignores SIGTERM", async () => {
    // Without this the supervisor awaits `childEnding` with no deadline, and
    // nothing else intervenes: the stop announced itself on disk, `host stop`
    // has already returned, and no service manager is watching this process. A
    // child that never handles SIGTERM would leave the supervisor waiting
    // forever while the host it was told to stop kept serving.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    const killed: string[] = [];
    let stopLanded = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 5,
            hasStopIntent: async () => stopLanded,
            // Fire the escalation immediately instead of after 30s.
            escalateAfter: (_ms, run) => {
              setImmediate(run);
              return () => undefined;
            },
            spawn: (command, args, options) => {
              originalSpawn(command, args, options);
              stopLanded = true;
              const child = makeStubChild();
              child.kill = (signal: NodeJS.Signals | undefined) => {
                killed.push(String(signal));
                // SIGTERM is IGNORED - only the escalation ends this child.
                if (signal === "SIGKILL") {
                  setImmediate(() => {
                    child.emit("exit", null, "SIGKILL");
                  });
                }
                return true;
              };
              return asChildProcess(child);
            },
          },
        ),
      recorded,
    );

    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
    // Still a deliberate stop: no relaunch, and no nonzero exit asking the
    // service manager to start a replacement.
    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.exited).toBe(0);
  });

  it("cancels the escalation when the raced stop's child exits on its own", async () => {
    // The ordinary path. A 30s timer left armed per attempt would keep the
    // supervisor's event loop busy long after the child is gone.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let cancelled = false;
    let escalated = false;
    let stopLanded = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 5,
            hasStopIntent: async () => stopLanded,
            escalateAfter: (_ms, run) => {
              const timer = setTimeout(() => {
                escalated = true;
                run();
              }, 10_000);
              return () => {
                cancelled = true;
                clearTimeout(timer);
              };
            },
            spawn: (command, args, options) => {
              originalSpawn(command, args, options);
              stopLanded = true;
              const child = makeStubChild();
              child.kill = (signal: NodeJS.Signals | undefined) => {
                setImmediate(() => {
                  child.emit("exit", null, signal ?? "SIGTERM");
                });
                return true;
              };
              return asChildProcess(child);
            },
          },
        ),
      recorded,
    );

    expect(cancelled).toBe(true);
    expect(escalated).toBe(false);
    expect(recorded.spawnCalls).toHaveLength(1);
  });

  it("kills a child that a stop raced between the guard and the spawn", async () => {
    // The pre-spawn guard cannot close a CROSS-PROCESS window: `host stop` can
    // write intent just after that read returned false, scan for a host while
    // this child does not exist yet, find nothing to kill, and return
    // successfully - leaving a host running that the stopper never saw.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const killed: string[] = [];
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let spawns = 0;
    let stopLanded = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 5,
            // False for the pre-spawn guard, true immediately afterwards.
            hasStopIntent: async () => stopLanded,
            spawn: (command, args, options) => {
              spawns += 1;
              originalSpawn(command, args, options);
              stopLanded = true;
              const child = makeStubChild();
              child.kill = (signal: NodeJS.Signals | undefined) => {
                killed.push(String(signal));
                setImmediate(() => {
                  child.emit("exit", null, signal ?? "SIGTERM");
                });
                return true;
              };
              return asChildProcess(child);
            },
          },
        ),
      recorded,
    );

    expect(spawns).toBe(1);
    expect(killed).toEqual(["SIGTERM"]);
    // And the death it caused is NOT then treated as a crash to recover from -
    // in BOTH halves. The signal death is abnormal, so only the latch keeps the
    // spawn count at one, and only the cause keeps the exit code at zero. A
    // nonzero exit here would have the service manager start a replacement.
    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.exited).toBe(0);
  });

  it("disposes a timed-out stderr stream instead of carrying it into the next attempt", async () => {
    // The diagnostic wait is bounded because a grandchild can inherit the dead
    // host's stderr and hold the pipe open. When that bound expires the stream
    // is still live, still feeding this attempt's tee, and still holds a libuv
    // handle - and the five-relaunch budget does not bound the accumulation,
    // because sustained uptime resets the counter.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    const stderrs: PassThrough[] = [];
    let spawns = 0;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 1,
            spawn: (command, args, options) => {
              spawns += 1;
              originalSpawn(command, args, options);
              const child = makeStubChild();
              // Never ends: exactly the grandchild-holding-the-pipe case.
              const stderr = new PassThrough();
              stderrs.push(stderr);
              Object.assign(child, { stderr });
              setImmediate(() => {
                child.emit("exit", spawns === 1 ? 3 : 0, null);
              });
              return asChildProcess(child);
            },
          },
        ),
      recorded,
    );

    expect(stderrs).toHaveLength(2);
    for (const stderr of stderrs) {
      expect(stderr.destroyed).toBe(true);
      expect(stderr.listenerCount("data")).toBe(0);
    }
  });

  it("relaunches a child signalled directly, even with a signal it could have forwarded", async () => {
    // An operator or watchdog sending SIGTERM to the HOST does not go through
    // this supervisor: the latch stays false and no intent is written. An
    // earlier classifier read the signal NAME and concluded the death was
    // requested, so the host stayed down.
    //
    // A signal name says a stop COULD have been forwarded, never that it was.
    // Only the latch and the sentinel carry that, and both are checked in
    // `decideRelaunch` - which is why classification here is now simply "any
    // signal death is abnormal".
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: null, signal: "SIGTERM" },
      { code: 0, signal: null },
    ]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 5 },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(2);
    expect(recorded.exited).toBe(0);
  });

  it("relaunches a host the OOM killer took, which no diagnostic whitelist names", async () => {
    // Recoverability and diagnosability are different questions, and deciding
    // one with the other's answer is the bug this pins. `describeFatalSignal`
    // lists native-crash signals so a support log can explain them; SIGKILL is
    // deliberately absent because there is nothing to explain. Keying "should
    // we relaunch" off that list made the single most likely signal death on
    // Linux - the OOM killer - the one death that was never recovered.
    //
    // The real question is only whether the death was ASKED FOR, and this
    // supervisor asks with SIGTERM/SIGINT/SIGHUP.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: null, signal: "SIGKILL" },
      { code: 0, signal: null },
    ]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 5 },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(2);
    expect(recorded.exited).toBe(0);
  });

  it("does not relaunch when a stop was requested", async () => {
    // The Windows half of the deliberate-stop guard: `schtasks /End` never
    // signals this process, so a stop announces itself on disk instead.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 1, signal: null }]);
    let intentChecks = 0;
    // The stop is requested while the FIRST child is running - the ordinary
    // shape. Returning `true` from the start would instead exercise the
    // spawn-boundary guard and never let a child run at all, which is a
    // different test (see the setup-window cases below).
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            spawn: (command, args, options) => {
              const child = scripted.deps.spawn?.(command, args, options);
              stopRequested = true;
              if (child === undefined) {
                throw new Error("test spawn dependency missing");
              }
              return child;
            },
            hasStopIntent: async () => {
              intentChecks += 1;
              return stopRequested;
            },
          },
        ),
      recorded,
    );

    // Three halves, really: the guard was consulted, nothing respawned, AND the
    // exit code does not ask the platform to respawn on our behalf. Asserting
    // only the spawn count would pass if the loop never ran - and asserting the
    // child's code, as this used to, passed while the stop was undone one
    // process later.
    expect(intentChecks).toBeGreaterThanOrEqual(1);
    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.exited).toBe(0);
  });

  it("abandons the relaunch when another host claims the data dir during backoff", async () => {
    // Backoff holds a claim on the data dir for seconds-to-minutes while
    // nothing serves. `traycer host ensure` can legitimately win that race, and
    // stacking a second host on top is what the incumbent policy exists to
    // prevent. Declining is never eviction: exit 0, leave the winner alone.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 3, signal: null }]);
    let incumbentCalls = 0;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            findIncumbentHost: async () => {
              incumbentCalls += 1;
              // Absent at the entry gate, present by the time we would respawn.
              return incumbentCalls === 1
                ? null
                : {
                    pid: 5150,
                    version: "1.1.9",
                    websocketUrl: "ws://127.0.0.1:9/rpc",
                  };
            },
          },
        ),
      recorded,
    );

    expect(incumbentCalls).toBe(2);
    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.exited).toBe(0);
  });

  it("re-resolves the install target on every attempt", async () => {
    // An install swap renames `install/` aside mid-life. A supervisor holding
    // the first attempt's path would relaunch a binary that has moved - today a
    // fresh launchd-spawned supervisor re-resolves, and the loop must keep that.
    const moved = "/opt/traycer/host/install/traycer-host-v2";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: 4, signal: null },
      { code: 0, signal: null },
    ]);
    let reads = 0;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            readInstallRecord: async () => {
              reads += 1;
              return sampleRecord(reads === 1 ? exec : moved);
            },
            pathExists: async () => true,
          },
        ),
      recorded,
    );

    expect(reads).toBe(2);
    expect(recorded.spawnCalls[0]?.command).toBe(exec);
    expect(recorded.spawnCalls[1]?.command).toBe(moved);
  });

  it("reopens the host log fd for each attempt", async () => {
    // The host rotates host.log BY RENAME. An fd held across a rotation writes
    // the next child's stdout into host.log.1 - the same hazard oss #982 fixed
    // for the stderr tee.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: 5, signal: null },
      { code: 0, signal: null },
    ]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 5 },
        ),
      recorded,
    );

    expect(recorded.sequence.filter((s) => s === "open-fd")).toHaveLength(2);
    expect(recorded.sequence.filter((s) => s === "rotate")).toHaveLength(2);
  });

  it("registers one set of signal listeners no matter how many attempts run", async () => {
    // Five relaunches must not install five listener sets on `process` - and
    // the one set that IS installed must not outlive the call. Production
    // never notices the second half, because `deps.exit` is `process.exit`
    // there; an injected `exit` returns, and every such call used to strand
    // three listeners.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 6, signal: null }]);
    const before = process.listenerCount("SIGTERM");
    const duringRun: number[] = [];
    const originalSpawn = scripted.deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 3,
            spawn: (command, args, options) => {
              duringRun.push(process.listenerCount("SIGTERM") - before);
              return originalSpawn(command, args, options);
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(4);
    // One set while running, on every attempt - not one set per attempt.
    expect(duringRun).toEqual([1, 1, 1, 1]);
    // And nothing left behind once the supervisor has returned.
    expect(process.listenerCount("SIGTERM") - before).toBe(0);
  });

  it("resets the budget only after a child that actually ran for the sustained window", async () => {
    // The governor's hard-won rule, transplanted: a host that dies shortly
    // after boot every time answers "it started" every time, and treating that
    // as recovery is what let the original respawn loop re-arm itself forever.
    // Here every child dies INSTANTLY, so the budget must still terminate.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 8, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          { ...scripted.deps, maxRelaunches: 2 },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(3);
    expect(recorded.exited).toBe(8);
  });

  it("measures that window at the child's DEATH, not after the diagnostics", async () => {
    // `ranForMs` used to read the clock where it was compared, which is on the
    // far side of the whole post-mortem: the stderr end wait (2s), the tee
    // flush (1s) and the bounded crash-report scan (2s). A child that died a
    // second short of the window was therefore credited with five seconds it
    // never ran, cleared the bar, and reset the budget - every time. That is
    // the governor's own re-arming bug, and D7 exists to prevent exactly it.
    //
    // Here every child dies 1s short of the window and the diagnostics burn 5s,
    // so the two readings fall on opposite sides of the threshold.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-08-06T00:00:00.000Z"));
      const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      // The 6th outcome is a CLEAN exit, purely so the buggy reading
      // terminates: without it, a budget that keeps resetting never stops and
      // this test would hang instead of failing.
      const scripted = withScriptedAttempts(deps, [
        { code: 9, signal: null },
        { code: 9, signal: null },
        { code: 9, signal: null },
        { code: 9, signal: null },
        { code: 9, signal: null },
        { code: 0, signal: null },
      ]);
      const scriptedSpawn = scripted.deps.spawn;
      // The post-mortem writes through `writeTerminalMarker`, NOT `writeMarker`
      // - `writeMarker` only carries "starting" and "failed-to-spawn", so
      // hooking it puts the clock advance AFTER `ranForMs` is computed and
      // makes this test inert. It was, until a mutation probe survived.
      const scriptedTerminal = scripted.deps.writeTerminalMarker;
      if (scriptedSpawn === undefined || scriptedTerminal === undefined) {
        throw new Error("test dependencies missing");
      }

      await runUntilExit(
        () =>
          runHostStart(
            { environment: "production", cwd: null },
            {
              ...scripted.deps,
              maxRelaunches: 2,
              sleep: async () => undefined,
              spawn: (command, args, options) => {
                const child = scriptedSpawn(command, args, options);
                // `childSpawnedAtMs` is stamped before this call, so advancing
                // here is the child running. It dies one second short.
                vi.setSystemTime(
                  Date.now() + SUSTAINED_UPTIME_RESET_MS - 1_000,
                );
                return child;
              },
              writeTerminalMarker: (environment, phase, fields) => {
                // The post-mortem, between the child's death and the comparison.
                if (phase === "crashed") {
                  vi.setSystemTime(Date.now() + 5_000);
                }
                scriptedTerminal(environment, phase, fields);
              },
            },
          ),
        recorded,
      );

      // 1 initial + 2 relaunches, then the budget is spent. Reading the clock
      // after the diagnostics instead reaches the 6th, clean-exit attempt.
      expect(recorded.spawnCalls).toHaveLength(3);
      expect(recorded.exited).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Regressions found by cold review of the relaunch loop. Each of these passed
// the original loop tests and was still wrong.
// ---------------------------------------------------------------------------

describe("runHostStart - relaunch loop, guards re-checked across the backoff", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("honours a stop that lands DURING the backoff, not just one already present", async () => {
    // The original code sampled stop intent once and then slept up to a
    // minute, so a `traycer host stop` arriving mid-backoff was decided
    // against before it happened - and the supervisor respawned a host the
    // user had just stopped. The backoff window is exactly when a stop is
    // most likely to land, because the host is already down.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 1, signal: null }]);
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            hasStopIntent: async () => stopRequested,
            // The stop happens WHILE we are backing off.
            sleep: async () => {
              stopRequested = true;
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(1);
    // Exit 0, NOT the crashed child's 1. This assertion used to read `toBe(1)`,
    // which quietly gave back everything the refusal above had just won: launchd
    // (`KeepAlive{SuccessfulExit:false}`), systemd (`Restart=on-failure`) and the
    // Scheduled Task all treat a nonzero exit as a crash and start a REPLACEMENT
    // supervisor, and that one reads the stop intent as older than its own
    // invocation - already served - and spawns the host. Honouring the stop and
    // then reporting a crash is not honouring the stop.
    expect(recorded.exited).toBe(0);
  });

  it("honours a shutdown signal that lands DURING the backoff", async () => {
    // Same race through the POSIX door: `launchctl bootout` signals this
    // process mid-backoff. A boolean snapshot taken before the await cannot
    // see it, which is why the decision reads a live getter.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 1, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            sleep: async () => {
              process.emit("SIGTERM");
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.exited).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The exit code IS the refusal, on every route out of the loop.
//
// `decideRelaunch` returning `stop` only settles what THIS process does next.
// What the machine does next is decided by the number this process exits with,
// because launchd (`KeepAlive{SuccessfulExit:false}`), systemd
// (`Restart=on-failure`) and the Scheduled Task's `RestartOnFailure` all read a
// nonzero exit as a crash worth answering with a fresh supervisor - and that
// supervisor starts AFTER the stop intent was written, so it reads the record as
// already served and starts the host. A stop honoured with a nonzero exit is a
// stop that survives one process.
//
// Reported against the target-resolution branch; the same mistake was in all
// four, so these pin every one, plus the budget half that must NOT change.
// ---------------------------------------------------------------------------

describe("runHostStart - a stop exits 0 wherever it is honoured", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("exits 0, not 69, when a stop interrupts target-resolution retries", async () => {
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 0, signal: null }]);
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host",
          },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            // The install record never comes back, so every attempt fails to
            // resolve a target and the loop keeps retrying.
            readInstallRecord: async () => null,
            hasStopIntent: async () => stopRequested,
            sleep: async () => {
              stopRequested = true;
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(0);
  });

  it("still exits 69 when target resolution runs out of budget instead", async () => {
    // The other half, and the reason this is a `cause` rather than a blanket
    // "stop means 0": exhaustion deliberately hands the machine back to the
    // platform, and it needs the nonzero code to do that.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 0, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host",
          },
          {
            ...scripted.deps,
            maxRelaunches: 0,
            readInstallRecord: async () => null,
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(69);
  });

  it("exits 0, not 66, when a stop interrupts a throwing spawn", async () => {
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host",
          },
          {
            ...deps,
            maxRelaunches: 5,
            spawn: (command, args, options) => {
              originalSpawn(command, args, options);
              throw new Error("EBUSY: install swap in progress");
            },
            hasStopIntent: async () => stopRequested,
            sleep: async () => {
              stopRequested = true;
            },
          },
        ),
      recorded,
    );

    expect(recorded.exited).toBe(0);
  });

  it("exits 0, not 66, when a stop interrupts an async spawn failure", async () => {
    // `spawn()` reporting through the `error` event rather than throwing is a
    // platform detail, so the two routes must not disagree about this either.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host",
          },
          {
            ...deps,
            maxRelaunches: 5,
            spawn: (command, args, options) => {
              originalSpawn(command, args, options);
              const child = makeStubChild();
              setImmediate(() => {
                child.emit("error", new Error("ENOENT: bundle vanished"));
              });
              return asChildProcess(child);
            },
            hasStopIntent: async () => stopRequested,
            sleep: async () => {
              stopRequested = true;
            },
          },
        ),
      recorded,
    );

    expect(recorded.exited).toBe(0);
  });
});

describe("runHostStart - relaunch loop, per-attempt isolation", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("arms the transition probe on the first attempt only", async () => {
    // The probe answers "did THIS transition succeed" - a one-shot verdict
    // owned by the install/restart lifecycle. A relaunch re-arming it would
    // overwrite that verdict with the outcome of unrelated recovery work.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const markerWrites: ProbeMarker[] = [];
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    // Every attempt gets a child with a READABLE fd 3. Without one the probe
    // observer has nothing to attach to and writes no marker at all - which is
    // why the earlier version of this test could assert nothing about
    // verdicts and passed with the observer reading the wrong context.
    let spawns = 0;
    const scripted = {
      deps: {
        ...deps,
        spawn: (command: string, args: readonly string[], options: object) => {
          spawns += 1;
          originalSpawn(command, args, options);
          const child = makeStubChild();
          Object.assign(child, {
            stdio: [null, null, null, new PassThrough()],
          });
          const code = spawns === 1 ? 2 : 0;
          setImmediate(() => {
            child.emit("exit", code, null);
          });
          return asChildProcess(child);
        },
      },
    };

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            probe: {
              transitionId: "t-1",
              probeNonce: "n-1",
              serviceLabel: "ai.traycer.host",
            },
          },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            readLiveProbeContext: async () => ({
              kind: "authorised" as const,
              context: {
                transitionId: "t-1",
                probeNonce: "n-1",
                serviceLabel: "ai.traycer.host",
              },
            }),
            attestProbeSupervisor: async () => ({
              serviceLabel: "ai.traycer.host",
              supervisorPid: process.pid,
              capturedAt: "2026-08-05T00:00:00.000Z",
            }),
            writeProbeMarker: async (_environment, marker) => {
              markerWrites.push(marker);
            },
            // Answer with a frame for whichever attempt is being observed
            // right now. `observeProbeStatus` discards a frame whose
            // `attemptId` does not match, so a fixed id here would make the
            // test vacuous in exactly the direction that hides the bug.
            readLayer0Frame: async () => {
              const ids = startingAttemptIds(recorded);
              return {
                kind: "frame" as const,
                frame: {
                  attemptId: ids[ids.length - 1] ?? "",
                  layer0: "acquired" as const,
                },
              };
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(2);
    // Attempt 1 is the probe attempt: fd 3 is opened and the flag passed.
    // Attempt 2 must carry neither, or the host writes a status frame for a
    // transition that was already decided.
    const first = recorded.spawnCalls[0];
    const second = recorded.spawnCalls[1];
    expect(first?.args).toContain("--layer0-status-fd");
    expect(second?.args).not.toContain("--layer0-status-fd");
    expect((first?.stdio as unknown[]).length).toBe(4);
    expect((second?.stdio as unknown[]).length).toBe(3);
    // THE LOAD-BEARING ASSERTIONS. argv and stdio alone are satisfied by the
    // spawn sites using the per-attempt context while the OBSERVER still reads
    // the outer one - exactly the defect this test is named for, and it passed
    // that way.
    //
    // Two writes belong to the PROBE attempt: the observation
    // (`awaiting-readiness`, from its Layer-0 frame) and the finalization that
    // resolves it once the child's fate is known. Attempt 2 observing as well
    // would make it four, and would resolve a second terminal verdict over the
    // first - which is what "one-shot" forbids.
    expect(markerWrites).toHaveLength(2);
    expect(
      markerWrites.filter((m) => m.outcome.kind === "terminal"),
    ).toHaveLength(1);
  });

  it("releases the supervisor's log descriptor for every attempt", async () => {
    // The supervisor now outlives many attempts, and a sustained-uptime reset
    // can extend the loop indefinitely - so an fd opened per attempt and never
    // closed is an unbounded leak, not a bounded one.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 4, signal: null }]);
    const opened: number[] = [];
    const closed: number[] = [];
    let nextFd = 100;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 2,
            openLogFd: async () => {
              nextFd += 1;
              opened.push(nextFd);
              return nextFd;
            },
            closeLogFd: async (fd) => {
              closed.push(fd);
            },
          },
        ),
      recorded,
    );

    expect(opened).toHaveLength(3);
    expect(closed).toEqual(opened);
  });

  // The test above exercises ordinary child EXITS only, which is why removing
  // the close on the synchronous-throw path left it green. Each attempt-end
  // route gets its own case: an fd is a per-attempt resource, and "some paths
  // close it" is the shape of a leak, not the absence of one.
  const FD_RELEASE_CASES: ReadonlyArray<{
    readonly name: string;
    readonly arrange: (
      deps: Partial<RunHostStartDeps>,
      recorded: Recorded,
    ) => Partial<RunHostStartDeps>;
  }> = [
    {
      name: "a synchronous spawn throw",
      arrange: (deps) => {
        const originalSpawn = deps.spawn;
        if (originalSpawn === undefined) {
          throw new Error("test spawn dependency missing");
        }
        return {
          ...deps,
          spawn: (command, args, options) => {
            originalSpawn(command, args, options);
            throw new Error("EBUSY: install swap in progress");
          },
        };
      },
    },
    {
      name: "an asynchronous child spawn error",
      arrange: (deps) => {
        const originalSpawn = deps.spawn;
        if (originalSpawn === undefined) {
          throw new Error("test spawn dependency missing");
        }
        return {
          ...deps,
          spawn: (command, args, options) => {
            originalSpawn(command, args, options);
            const child = makeStubChild();
            setImmediate(() => {
              child.emit("error", new Error("ENOENT: no such file"));
            });
            return asChildProcess(child);
          },
        };
      },
    },
  ];

  for (const testCase of FD_RELEASE_CASES) {
    it(`releases the supervisor's log descriptor after ${testCase.name}`, async () => {
      const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      const opened: number[] = [];
      const closed: number[] = [];
      let nextFd = 200;
      const arranged = testCase.arrange(deps, recorded);

      await runUntilExit(
        () =>
          runHostStart(
            { environment: "production", cwd: null },
            {
              ...arranged,
              maxRelaunches: 0,
              openLogFd: async () => {
                nextFd += 1;
                opened.push(nextFd);
                return nextFd;
              },
              closeLogFd: async (fd) => {
                closed.push(fd);
              },
            },
          ),
        recorded,
      );

      expect(opened).toHaveLength(1);
      expect(closed).toEqual(opened);
    });
  }

  it("releases the supervisor's log descriptor when a stop preempts the spawn", async () => {
    // The pre-spawn guard returns without ever reaching the child, so it owns
    // the fd it just opened.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 0, signal: null }]);
    const opened: number[] = [];
    const closed: number[] = [];
    let nextFd = 300;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 0,
            openLogFd: async () => {
              nextFd += 1;
              opened.push(nextFd);
              return nextFd;
            },
            closeLogFd: async (fd) => {
              closed.push(fd);
            },
            hasStopIntent: async () => true,
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(0);
    expect(opened).toHaveLength(1);
    expect(closed).toEqual(opened);
  });
});

describe("runHostStart - relaunch loop, spawn-failure policy", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("retries a synchronous spawn throw on a relaunch, like the async one", async () => {
    // Whether `spawn()` throws or reports through the `error` event is a
    // platform detail. Letting the two disagree meant a transient EBUSY
    // mid-swap could still exit a supervisor that had budget left.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let calls = 0;
    const child = makeStubChild();

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 3,
            spawn: (command, args, options) => {
              calls += 1;
              originalSpawn(command, args, options);
              // Attempt 1 crashes; attempt 2's spawn throws synchronously.
              if (calls === 2) {
                throw new Error("EBUSY: install swap in progress");
              }
              setImmediate(() => {
                child.emit("exit", calls === 1 ? 7 : 0, null);
              });
              return asChildProcess(child);
            },
          },
        ),
      recorded,
    );

    // 1 crash, 1 sync throw that was RETRIED, then a clean run.
    expect(calls).toBe(3);
    expect(recorded.exited).toBe(0);
  });

  it("leaves terminal evidence when a relaunch cannot resolve its target", async () => {
    // A retry that wrote only a `starting` marker left host.log claiming an
    // attempt began with nothing to say why it never spawned - int #4839 reads
    // exactly these markers to explain a failed start.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 3, signal: null }]);
    let reads = 0;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 1,
            readInstallRecord: async () => {
              reads += 1;
              // Attempt 1 resolves; the relaunch finds the install gone.
              return reads === 1 ? sampleRecord(exec) : null;
            },
          },
        ),
      recorded,
    );

    const failed = recorded.markers.filter(
      (m) => m.phase === "failed-to-spawn",
    );
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.fields.error)).toContain("HOST_NOT_INSTALLED");
  });

  it("retries a FIRST-attempt spawn failure when the service manager started it", async () => {
    // The Windows hole an attempt-number gate left open: a Scheduled Task
    // action that hits a transient EBUSY mid-swap on its very first spawn
    // exits, handing the machine back to the `RestartOnFailure` mechanism this
    // loop exists precisely because it cannot be relied on. Nothing is
    // listening to a service start, so it spends the budget instead.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let calls = 0;
    const child = makeStubChild();

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host",
          },
          {
            ...deps,
            maxRelaunches: 3,
            spawn: (command, args, options) => {
              calls += 1;
              originalSpawn(command, args, options);
              if (calls === 1) {
                throw new Error("EBUSY: install swap in progress");
              }
              setImmediate(() => {
                child.emit("exit", 0, null);
              });
              return asChildProcess(child);
            },
          },
        ),
      recorded,
    );

    expect(calls).toBe(2);
    expect(recorded.exited).toBe(0);
  });

  it("surfaces a FIRST-attempt spawn failure immediately for an interactive start", async () => {
    // The other half of the same decision. A person - or Desktop, which parses
    // the result envelope and is waiting on it - must not sit through the full
    // backoff ladder before being told the install is broken.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const originalSpawn = deps.spawn;
    if (originalSpawn === undefined) {
      throw new Error("test spawn dependency missing");
    }
    let calls = 0;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 3,
            spawn: (command, args, options) => {
              calls += 1;
              originalSpawn(command, args, options);
              throw new Error("EBUSY: install swap in progress");
            },
          },
        ),
      recorded,
    );

    expect(calls).toBe(1);
    expect(recorded.exited).toBe(66);
  });

  it("retries a FIRST-attempt target-resolution failure only for a service start", async () => {
    // Same split, on the other failure route: a task action whose install
    // record is momentarily absent mid-swap retries, an interactive start
    // reports E_HOST_NOT_INSTALLED now.
    const serviceRun = makeRunStubs(sampleRecord(exec), null);
    const serviceScripted = withScriptedAttempts(serviceRun.deps, [
      { code: 0, signal: null },
    ]);
    let serviceReads = 0;

    await runUntilExit(
      () =>
        runHostStart(
          {
            environment: "production",
            cwd: null,
            serviceLabel: "ai.traycer.host",
          },
          {
            ...serviceScripted.deps,
            maxRelaunches: 2,
            readInstallRecord: async () => {
              serviceReads += 1;
              return serviceReads === 1 ? null : sampleRecord(exec);
            },
          },
        ),
      serviceRun.recorded,
    );

    expect(serviceRun.recorded.spawnCalls).toHaveLength(1);
    expect(serviceRun.recorded.exited).toBe(0);

    const interactiveRun = makeRunStubs(sampleRecord(exec), null);
    const interactiveScripted = withScriptedAttempts(interactiveRun.deps, [
      { code: 0, signal: null },
    ]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...interactiveScripted.deps,
            maxRelaunches: 2,
            readInstallRecord: async () => null,
          },
        ),
      interactiveRun.recorded,
    );

    expect(interactiveRun.recorded.spawnCalls).toHaveLength(0);
    expect(interactiveRun.recorded.exited).toBe(69);
  });
});

describe("runHostStart - production defaults", () => {
  it("wires the real budget and backoff ladder when nothing is injected", async () => {
    // Every other test injects `maxRelaunches`, so without this the shipped
    // default (5) and the ladder are never exercised end to end.
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 11, signal: null }]);
    const slept: number[] = [];
    const { maxRelaunches: _omitted, ...withoutBudget } = scripted.deps;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...withoutBudget,
            sleep: async (ms) => {
              slept.push(ms);
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(MAX_CONSECUTIVE_RELAUNCHES + 1);
    expect(slept).toEqual([...RELAUNCH_BACKOFF_MS]);
    expect(recorded.exited).toBe(11);
  });

  it("keeps the backoff timer referenced so the supervisor survives the wait", async () => {
    // Every other test injects `sleep`, so the REAL one is otherwise never
    // exercised - and it is the only thing holding the event loop open during
    // a backoff. By then the child is dead, its stderr is closed and the log
    // descriptor has been released; signal listeners do not ref the loop and
    // neither does an awaited promise. An `unref()`ed timer here means Node
    // drains and exits 0 mid-wait, and the relaunch never happens - silently,
    // in production only.
    // Spy on the timer factory so this observes the handle created by `sleep`
    // itself, rather than comparing against unrelated process-wide timers.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const pending = defaultRunHostStartDeps.sleep(20);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      const timerResult = setTimeoutSpy.mock.results.at(-1);
      if (timerResult?.type !== "return") {
        throw new Error("sleep did not return a timer handle");
      }
      expect(timerResult.value.hasRef()).toBe(true);

      await pending;
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("keeps the raced-stop escalation timer referenced, and cancels it on demand", async () => {
    // Same argument as the backoff timer, one path over: this timer is the only
    // thing that ends an unbounded wait on a child that will not honour
    // SIGTERM. Unref'd, Node could decide the supervisor had nothing left to do
    // and exit while the host it was told to stop kept serving.
    const countTimers = (): number =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    const before = countTimers();
    let fired = false;
    const cancel = defaultRunHostStartDeps.escalateAfter(60_000, () => {
      fired = true;
    });
    const during = countTimers();
    cancel();

    expect(during).toBe(before + 1);
    // And the canceller really cancels - otherwise the ordinary path leaks a
    // 30s timer per attempt.
    expect(countTimers()).toBe(before);
    expect(fired).toBe(false);
  });

  it("gives a raced stop longer than the host's own force-exit watchdog", async () => {
    // Derived, not chosen. A functioning host arms its own force-exit watchdog,
    // so a grace at or below it would SIGKILL hosts that were moments from
    // completing the exact shutdown we asked for. This is the assertion that
    // fails if someone later "tunes" the constant down to a literal.
    expect(RACED_STOP_KILL_GRACE_MS).toBeGreaterThan(SHUTDOWN_FORCE_EXIT_MS);
  });
});

describe("runHostStart - stop signals outside the child-running window", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("does not spawn when a shutdown signal arrives during per-attempt setup", async () => {
    // Installing the signal handlers once, up front, SUPPRESSES Node's default
    // "die on SIGTERM". The single-shot supervisor relied on that default: it
    // registered its handler only after spawning, so a signal during setup
    // killed the process. Setup is a chain of awaits, and a stop landing in it
    // must not be followed by a brand-new child that never received it.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...deps,
            maxRelaunches: 5,
            // Stand in for any await in the setup chain.
            openLogFd: async () => {
              process.emit("SIGTERM");
              return 42;
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(0);
  });

  it("ignores the stop intent it saw at startup, so the next crash is recoverable", async () => {
    // Stop the host, log back in inside the sentinel's freshness window, and
    // the new supervisor must not read the previous stop as still in progress
    // and refuse to recover its OWN child's first crash.
    //
    // The record is REMEMBERED, never deleted: an earlier version cleared the
    // file at startup, which erased any stop that landed between this
    // invocation and the clear. The stub below models the real
    // `hasActionableStopIntent` contract rather than a boolean, so it fails if
    // the supervisor stops handing down the identity it saw at startup.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: 5, signal: null },
      { code: 0, signal: null },
    ]);
    const startupRecord = {
      requestedAt: "2026-08-06T12:00:00.000Z",
      requestedByPid: 4242,
    };
    let servedSeen: StopIntentIdentity | null = null;
    let sawIdentity = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            readStopIntentIdentity: async () => startupRecord,
            hasStopIntent: async (_environment, _nowMs, servedAtStartup) => {
              servedSeen = servedAtStartup;
              sawIdentity = true;
              // The record on disk IS the one this supervisor started with, so
              // its own start already answered it. Deliberately no clock here:
              // that is the whole point of the identity rule.
              return servedAtStartup === null;
            },
          },
        ),
      recorded,
    );

    // The supervisor actually handed down the startup identity rather than
    // null, which would make every pre-existing record look actionable.
    expect(sawIdentity).toBe(true);
    expect(servedSeen).toEqual(startupRecord);
    // The crash WAS recovered rather than misread as part of the old stop.
    expect(recorded.spawnCalls).toHaveLength(2);
    expect(recorded.exited).toBe(0);
  });

  it("does not spawn when stop intent lands during the FIRST attempt's setup", async () => {
    // The Windows shape, and the one a POSIX-only latch cannot see: `schtasks
    // /End` never signals this process, so `shuttingDown` stays false forever.
    // The stopper writes intent and scans for a child while the supervisor is
    // still opening its log - finding nothing to kill, because nothing has
    // been spawned yet. Without an intent read at the spawn boundary the
    // supervisor then starts a host after `host stop` already returned.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 0, signal: null }]);
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            openLogFd: async () => {
              stopRequested = true;
              return 42;
            },
            hasStopIntent: async () => stopRequested,
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(0);
    // The attempt already wrote `starting` before the guard ran, and
    // `spawn-evidence.ts` pairs that against a terminal marker. Leaving it
    // unpaired makes a cleanly stopped host read as an attempt still in
    // progress.
    expect(recorded.markers.map((m) => m.phase)).toEqual([
      "starting",
      "failed-to-spawn",
    ]);
  });

  it("does not spawn when stop intent lands during a RELAUNCH's setup", async () => {
    // Same hole one attempt later: `decideRelaunch` re-reads intent around the
    // backoff, but per-attempt setup is a chain of awaits AFTER that read, and
    // a stop can complete inside it.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [{ code: 9, signal: null }]);
    let attempts = 0;
    let stopRequested = false;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            openLogFd: async () => {
              attempts += 1;
              // Lands while attempt 2 is setting up - after the post-backoff
              // re-read has already passed.
              if (attempts === 2) stopRequested = true;
              return 42;
            },
            hasStopIntent: async () => stopRequested,
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.exited).toBe(0);
  });
});

describe("runHostStart - a stop that lands INSIDE the pre-spawn read", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("does not spawn when the signal arrives during the intent read itself", async () => {
    // The narrowest window in the pre-spawn guard, and the one operand order
    // decides. `||` short-circuits: asking `shuttingDown` FIRST reads it as of
    // before the intent await, so a signal delivered while that read is in
    // flight is invisible to the condition it is supposed to trip.
    //
    // Nothing downstream caught it either. The handler latches and forwards to
    // `currentChild`, still null this early, so the signal reached no process;
    // and the post-spawn guard is gated on `!shuttingDown`, which the latch had
    // just made false. The supervisor created a child AFTER a stop, never
    // signalled it, and sat waiting on it.
    //
    // `hasStopIntent` returning false is not a contrived stub: it is what
    // `launchctl bootout`, `systemctl stop`, and a CLI stop whose best-effort
    // intent write failed all look like. On those paths the signal IS the whole
    // notification.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    // Scripted so a regression spawns and then EXITS rather than hanging the
    // suite - the assertion below, not a timeout, is what reports it.
    const scripted = withScriptedAttempts(deps, [{ code: 0, signal: null }]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            hasStopIntent: async () => {
              process.emit("SIGTERM");
              return false;
            },
          },
        ),
      recorded,
    );

    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(0);
  });
});

describe("runHostStart - a marker write must never cost the host", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("still recovers a crash when every marker write fails", async () => {
    // `writeBootstrapMarker` is an `ensureHostHomeDir` plus an `appendFile`.
    // Awaited bare inside the loop, a transient EBUSY/EACCES/ENOSPC rejected
    // straight out of `runHostStart`; the entrypoint turned that into exit 1,
    // and exit 1 is precisely what the Windows Scheduled Task does NOT answer
    // with a fresh supervisor. A failed diagnostic write would have left the
    // machine hostless - this ticket's own outcome, reached through the code
    // that exists to explain it.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: 7, signal: null },
      { code: 0, signal: null },
    ]);

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            writeMarker: async () => {
              throw new Error("EBUSY: marker file momentarily locked");
            },
          },
        ),
      recorded,
    );

    // The crash was recovered on the evidence path's own failure: two spawns,
    // clean exit. Losing a line of evidence is the whole cost.
    expect(recorded.spawnCalls).toHaveLength(2);
    expect(recorded.exited).toBe(0);
  });
});

describe("runHostStart - per-attempt setup failures stay inside the budget", () => {
  const exec = "/opt/traycer/host/install/traycer-host";

  it("spends an attempt and retries when opening the log fd fails mid-ladder", async () => {
    // `openLogFd` is an `fs.open`, and a Windows scanner holding the file or a
    // momentary EACCES is not a statement about whether the host can run. It
    // used to reject straight out of `runHostStart`: the entrypoint turned that
    // into exit 1, and the Scheduled Task does not answer exit 1 with a fresh
    // supervisor - so a transient filesystem error ended the ladder and left
    // the machine hostless, mid-recovery from a crash the loop had already
    // decided to fix.
    //
    // It is NOT diagnostics, so swallowing it would be wrong too: the attempt
    // genuinely cannot proceed. The right answer is the policy target
    // resolution and spawn already had - cost an attempt, then retry.
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const scripted = withScriptedAttempts(deps, [
      { code: 7, signal: null },
      { code: 0, signal: null },
    ]);
    let opens = 0;

    await runUntilExit(
      () =>
        runHostStart(
          { environment: "production", cwd: null },
          {
            ...scripted.deps,
            maxRelaunches: 5,
            openLogFd: async () => {
              opens += 1;
              if (opens === 2) {
                throw new Error("EACCES: host.log momentarily unopenable");
              }
              return 42;
            },
          },
        ),
      recorded,
    );

    // Attempt 1 spawned and crashed, attempt 2 died in setup and cost a slot,
    // attempt 3 spawned and exited cleanly.
    expect(opens).toBe(3);
    expect(recorded.spawnCalls).toHaveLength(2);
    expect(recorded.exited).toBe(0);
    // The failed attempt still left a paired terminal marker behind.
    expect(recorded.markers.some((m) => m.phase === "failed-to-spawn")).toBe(
      true,
    );
  });
});
