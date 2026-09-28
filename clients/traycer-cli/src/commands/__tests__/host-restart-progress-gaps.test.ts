import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  WINDOWS_KILL_CONVERGENCE_ROUNDS,
  WINDOWS_PROCESS_KILL_TIMEOUT_MS,
  WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
  WINDOWS_SCHTASKS_END_TIMEOUT_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import type { ShutdownClaimIntent } from "@traycer/protocol/host/lifecycle/schemas";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { CliLockHandle } from "../../store/cli-lock";
import type {
  RestartStop,
  ServiceController,
  ServiceLabel,
  ServiceStatus,
} from "../../service";
import type { HostPidMetadata } from "../../host/pid-metadata";
import type {
  ProcessIdentityToken,
  ProcessIdentityVerdict,
} from "../../store/process-identity";

// The review's ruling (wall-clock silence, desktop-side): the desktop streams
// `host restart` through `streamBundledTraycerCliJson`, whose idle timer
// (`CLI_STREAM_IDLE_TIMEOUT_MS`, 600s) is re-armed by every NDJSON event the
// CLI writes.
//
// The eventual fix emits progress from an ambient per-command scope the
// RUNNER installs (`runner/bounded-wait-progress.ts`,
// `withBoundedWaitProgress`), not from the `CommandFn` itself - deep service
// code (`host/update-mutation.ts`, `service/platforms/desktop-agent-
// shutdown.ts`) calls `reportBoundedWait(...)` straight into that ambient
// scope. Driving `buildHostRestartCommand` directly, as this file's first
// version did, never installs that scope, so every such call was a silent
// no-op and the file could only ever see the top-level `ctx.progress` calls
// `host-restart.ts` itself makes (there are none). This version drives the
// REAL runner (`runCommand`) instead, so any progress the ambient scope
// carries is visible exactly as Desktop would see it.
//
// HOME is redirected to a private temp dir before anything reads it, same
// defensive pattern as every other file in this directory - `store/paths`
// binds `homedir()` at module load and nothing here may risk the real
// `~/.traycer`, even though almost everything this file touches is mocked
// below.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-host-restart-progress-gaps-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// Sentry is a runner-level side effect, not this file's concern - stubbed the
// way `runner-sentry-capture.test.ts` does, so importing the real runner
// never reaches a network client.
const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn<(err: unknown) => void>(),
  addBreadcrumb: vi.fn<(crumb: unknown) => void>(),
  close: vi.fn<(timeout: number) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
}));
vi.mock("@sentry/node", () => ({
  captureException: (err: unknown) => sentryMocks.captureException(err),
  addBreadcrumb: (crumb: unknown) => sentryMocks.addBreadcrumb(crumb),
  close: (timeout: number) => sentryMocks.close(timeout),
}));

// A plain `setTimeout`-backed sleep - the one every fake below uses, so
// every bounded wait in this file advances on `vi.useFakeTimers()`'s clock,
// never a real one.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// `vi.mock` factories are hoisted above this file's own top-level code -
// including its `import` statements - so a factory cannot read
// `LONGEST_SINGLE_BOUND_MS`/`CEILING_MS` (below) directly: at the time the
// factory *registers*, the protocol constants they are built from are not
// bound yet. This holder is itself hoisted (so factories may close over it),
// but its fields are only ever WRITTEN once, in ordinary module-scope code
// after the real imports resolve, and only ever READ later still - inside a
// mocked controller method, called long after this whole file finished
// loading.
const durations = vi.hoisted(() => ({
  stopLadderMs: 0,
  relaunchEdgeMs: 64_750,
  ackWaitMs: 50_000,
  statusReadMs: 10_000,
  refusedSupervisorWaitMs: 90_000,
}));

// The named bound every gap is checked against: the Windows stop ladder for
// ONE controller call - `WINDOWS_SCHTASKS_END_TIMEOUT_MS` (the `/End` wait)
// plus a bounded scan-then-kill convergence loop (N+1 scans, N kills - a
// final confirming scan the loop does not kill from). Derived from the same
// protocol constants the eventual production bound will read, never a
// hardcoded literal.
const LONGEST_SINGLE_BOUND_MS =
  WINDOWS_SCHTASKS_END_TIMEOUT_MS +
  (WINDOWS_KILL_CONVERGENCE_ROUNDS + 1) * WINDOWS_PROCESS_SCAN_TIMEOUT_MS +
  WINDOWS_KILL_CONVERGENCE_ROUNDS * WINDOWS_PROCESS_KILL_TIMEOUT_MS;

// `stopService` (platform Windows, `service/platforms/windows.ts:573`) runs a
// synchronous published-host identity probe BEFORE issuing `/End`:
// `publishedHostProcessGone` - `tasklist` (3s,
// `clients/shared/host-lock/process-identity.ts:63`), then the exact
// PowerShell creation-time read (5s, ~:816) with a 5s fallback (~:837) - up to
// 13s that stacks in FRONT of the stop ladder this file already derives.
// These per-step numbers are not exported by that module, so this is a named
// literal with this citation rather than an import.
const PUBLISHED_HOST_IDENTITY_PROBE_MS = 13_000;

// The real ceiling: one controller call's longest bound now includes the
// identity probe that precedes it.
const CEILING_MS = PUBLISHED_HOST_IDENTITY_PROBE_MS + LONGEST_SINGLE_BOUND_MS;
durations.stopLadderMs = CEILING_MS;

// Each `callHostRpcAtEndpoint` attempt (g4's cooperative-shutdown claim and
// commit) can itself take up to 225_600ms under the timer model: 3 attempts
// (`clients/shared/host-transport/retrying-messenger.ts`,
// `DEFAULT_TRANSPORT_RETRY_POLICY.maxRetries=2` -> maxRetries+1 attempts) x
// (10s dial + 15s openAck + 15s response + 35s attestation grace -
// `ws-rpc-client.ts` ~1286-1301) + ~0.6s cumulative jittered backoff between
// attempts. Named here rather than imported because the per-leg figures
// aren't exported constants.
const HOST_RPC_ATTEMPT_BOUND_MS = 225_600;

// ---- the world this file fakes ---------------------------------------------

// `../../host/update-contender`: the outer lock/attempt-record machinery is
// not this file's concern - only the gaps between progress events during the
// bounded work it admits. `withCliUpdateContenderContext` runs `run` directly
// against a fake capability/lock/context; `requireCliUpdateMutationCapability`
// always resolves; `readSupervisorRelaunchInstalledIdentity` returns a
// harmless value.
const recoveryAction = vi.hoisted(() => ({
  current: "restart-current" as "restart-current" | "stop-only",
}));
vi.mock("../../host/update-contender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-contender")>();
  const fakeCapability: UpdateMutationCapability = {
    hostHomeDir: "/fake/host-restart-progress-gaps-home",
  };
  const fakeLock: CliLockHandle = {
    path: "/fake/host-restart-progress-gaps.lock",
    metadata: {
      pid: process.pid,
      reason: "host-restart-progress-gaps-test",
      startedAt: "2026-01-01T00:00:00.000Z",
      hostname: null,
      token: null,
      processStartedAtMs: null,
      processStartIdentity: null,
    },
    release: async () => undefined,
  };
  return {
    ...actual,
    withCliUpdateContenderContext: async (
      _options: unknown,
      run: (
        capability: UpdateMutationCapability,
        cliLock: CliLockHandle,
        context: {
          readonly activeAttempt: null;
          readonly recoveryAction: "restart-current" | "stop-only";
        },
      ) => Promise<unknown>,
    ) =>
      run(fakeCapability, fakeLock, {
        activeAttempt: null,
        recoveryAction: recoveryAction.current,
      }),
    requireCliUpdateMutationCapability: async () => undefined,
    readSupervisorRelaunchInstalledIdentity: async () => null,
  };
});

// `@traycer-clients/shared/host-update`: only `supervisorRelaunchAdmitsStandingRecord`
// is faked - `false`, so `afterUnacknowledgedStart` (`host/update-mutation.ts`)
// always takes the refused-supervisor branch once it finds a live supervisor.
vi.mock("@traycer-clients/shared/host-update", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer-clients/shared/host-update")
    >();
  return {
    ...actual,
    supervisorRelaunchAdmitsStandingRecord: async () => false,
  };
});

// `../../host/incumbent-check`: no host ever answers in g1/g2's rows.
vi.mock("../../host/incumbent-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../host/incumbent-check")>()),
  findLiveIncumbentHost: async () => null,
}));

// `../../host/service-supervisor-relaunch`: a live supervisor is always on
// record, and `waitForSupervisorRelaunch` times out once (sleeping its own
// bound, 90s) then reports the supervisor gone on the second wait (also
// 90s) - the two waits `MAX_SUPERVISOR_RELAUNCH_WAITS` (2) allows.
const supervisorWaitCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../host/service-supervisor-relaunch", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../host/service-supervisor-relaunch")
    >();
  return {
    ...actual,
    findLiveServiceSupervisor: async () => ({ supervisorPid: 4242 }),
    waitForSupervisorRelaunch: async () => {
      supervisorWaitCalls.count += 1;
      await sleep(durations.refusedSupervisorWaitMs);
      return supervisorWaitCalls.count === 1
        ? { kind: "timed-out" as const }
        : { kind: "supervisor-gone" as const };
    },
  };
});

// `../../host/pid-metadata`: `isValidLocalHostWebsocketUrl` stays real (g4
// needs it to actually validate the fake record's URL). Everything else is
// switched per test through `pidMetadataConfig` - g1/g2/g3 read "absent" (so
// `hostProcessProvablyGone` is true and the retry-once-more branch fires);
// g4 (the cooperative-shutdown row) reads a live-looking record and reports
// its process as NOT provably gone, so `requestCooperativeShutdownReporting`
// (a REAL function in g4) proceeds to claim/commit.
const pidMetadataConfig = vi.hoisted(() => ({
  mode: "absent" as "absent" | "live",
  liveRecord: null as HostPidMetadata | null,
}));
vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadataEvidence: async () =>
      pidMetadataConfig.mode === "live" && pidMetadataConfig.liveRecord !== null
        ? { kind: "read" as const, metadata: pidMetadataConfig.liveRecord }
        : { kind: "absent" as const },
    readHostPidMetadata: async () =>
      pidMetadataConfig.mode === "live" ? pidMetadataConfig.liveRecord : null,
    publishedHostProcessGone: () => pidMetadataConfig.mode !== "live",
  };
});

// `../../store/cli-lock`: `isProcessAlive` is the pid probe
// `waitForCooperativeExit` (desktop-agent-shutdown.ts, unexported) polls
// every 150ms - real, unmocked. g4 makes the pid look alive for
// `cooperativeShutdown.pidAliveForMs` from the FIRST poll, then gone, so the
// cooperative exit resolves late (`stopped`, not `hung`).
const cooperativeShutdown = vi.hoisted(() => ({
  pidAliveForMs: 32_000,
  pidExitAtMs: null as number | null,
}));
vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    isProcessAlive: (_pid: number): boolean => {
      if (cooperativeShutdown.pidExitAtMs === null) {
        cooperativeShutdown.pidExitAtMs =
          Date.now() + cooperativeShutdown.pidAliveForMs;
      }
      return Date.now() < cooperativeShutdown.pidExitAtMs;
    },
  };
});

// `../../store/process-identity`: the cooperative path reads liveness
// asynchronously - `publishedHostProcessGoneAsync` before the claim and
// `waitForCooperativeExit`'s poll after it both go through
// `verifyProcessIdentityAsync` (a synchronous `tasklist` per poll would freeze
// the supervisor's loop on Windows). g4's record pid gets the same
// alive-then-gone clock as `isProcessAlive` above; every other pid is real.
vi.mock("../../store/process-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/process-identity")>();
  return {
    ...actual,
    verifyProcessIdentityAsync: async (
      token: ProcessIdentityToken,
    ): Promise<ProcessIdentityVerdict> => {
      const live = pidMetadataConfig.liveRecord;
      if (
        pidMetadataConfig.mode !== "live" ||
        live === null ||
        token.pid !== live.pid
      ) {
        return actual.verifyProcessIdentityAsync(token);
      }
      if (cooperativeShutdown.pidExitAtMs === null) {
        cooperativeShutdown.pidExitAtMs =
          Date.now() + cooperativeShutdown.pidAliveForMs;
      }
      return Date.now() < cooperativeShutdown.pidExitAtMs
        ? "alive-same"
        : "dead";
    },
  };
});

// `../../internal/host-rpc`: `callHostRpcAtEndpoint` fully replaced. Only the
// two methods g4's cooperative-shutdown leg issues are modelled - each sleeps
// `HOST_RPC_ATTEMPT_BOUND_MS` before granting/committing.
vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpcAtEndpoint: async (
      method: string,
      _params: Record<string, unknown>,
      _endpoint: unknown,
    ): Promise<Record<string, unknown>> => {
      if (method === "lifecycle.claimShutdown") {
        await sleep(HOST_RPC_ATTEMPT_BOUND_MS);
        return { granted: { token: "host-restart-progress-gaps-token" } };
      }
      if (method === "lifecycle.commitShutdown") {
        await sleep(HOST_RPC_ATTEMPT_BOUND_MS);
        return { committed: true };
      }
      throw new Error(`unexpected host RPC method in test: ${method}`);
    },
  };
});

// `../../service/spawn-edge`: replaces the whole lease/ack mechanism with
// exactly the two bounds this file models - the edge itself (`start()`, the
// controller's own bounded call) plus the ack wait (50s,
// `HOST_START_ADOPTION_ACK_WAIT_MS` - spawn-edge-bounds.ts). Whether the
// FIRST call is acknowledged is per-test (`spawnEdgeConfig`): g1/g2 need it
// unacknowledged/acknowledged respectively.
const spawnEdgeCalls = vi.hoisted(() => ({ count: 0 }));
const spawnEdgeConfig = vi.hoisted(() => ({ failFirstCall: true }));
vi.mock("../../service/spawn-edge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/spawn-edge")>();
  return {
    ...actual,
    runWithLeaseAtServiceSpawnEdge: async (
      _publish: () => Promise<unknown>,
      start: () => Promise<void>,
    ) => {
      spawnEdgeCalls.count += 1;
      await start();
      await sleep(durations.ackWaitMs);
      if (spawnEdgeConfig.failFirstCall && spawnEdgeCalls.count === 1) {
        throw new actual.SpawnAcknowledgementTimeoutError();
      }
    },
  };
});

// `../../upgrade/finalize-helper`: no prior marker to reconcile.
vi.mock("../../upgrade/finalize-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../upgrade/finalize-helper")>()),
  reconcilePostFinalizeMarker: async () => ({ status: "no-marker" as const }),
}));

// `../cli-upgrade`: nothing pending to finalize.
vi.mock("../cli-upgrade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli-upgrade")>()),
  finalizePendingCliUpgrade: async () => ({ status: "no-pending" as const }),
}));

// `../../host/attested-install-runtime`: a harmless, valid attestation.
vi.mock("../../host/attested-install-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../host/attested-install-runtime")
  >()),
  attestInstallRuntime: async () => ({
    installGeneration: "gen-1",
    runtimeVersion: "1.0.0",
    runtimeWasNull: false,
  }),
}));

// `../../service`: only `createServiceController` is faked; `serviceLabelFor`
// stays real. `stopForRestart` sleeps the stop-ladder bound (`CEILING_MS`,
// this file's ceiling - the probe plus the longest single bound),
// `relaunchAfterRestart` the relaunch edge (64.75s - spawn-edge-bounds.ts
// ~383-414, "Windows restart... -> 114.75s"), and `status` a 10s read. g4's
// `stopForRestart` instead calls the REAL cooperative-shutdown path and never
// sleeps `stopLadderMs` at all.
const controllerCalls = vi.hoisted(() => ({
  stopForRestart: 0,
  relaunchAfterRestart: 0,
  status: 0,
}));
const stopForRestartMode = vi.hoisted(() => ({
  kind: "sleep-stop-ladder" as "sleep-stop-ladder" | "cooperative-shutdown",
}));
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  const controller: Pick<
    ServiceController,
    | "status"
    | "stopForRestart"
    | "relaunchAfterRestart"
    | "hostStartAdoptionLabel"
  > = {
    status: async (): Promise<ServiceStatus> => {
      controllerCalls.status += 1;
      await sleep(durations.statusReadMs);
      return { state: "stopped", version: null, listenUrl: null, pid: null };
    },
    stopForRestart: async (): Promise<RestartStop> => {
      controllerCalls.stopForRestart += 1;
      if (stopForRestartMode.kind === "cooperative-shutdown") {
        const { requestCooperativeShutdownReporting } =
          await import("../../service/platforms/desktop-agent-shutdown");
        const intent: ShutdownClaimIntent = "restart";
        const outcome = await requestCooperativeShutdownReporting(
          "production",
          "restart",
          intent,
          null,
        );
        if (outcome.kind !== "stopped") {
          throw new Error(
            `test setup error: cooperative shutdown did not resolve "stopped" (got "${outcome.kind}")`,
          );
        }
        return { forcedRecycle: false };
      }
      await sleep(durations.stopLadderMs);
      return { forcedRecycle: false };
    },
    relaunchAfterRestart: async (): Promise<void> => {
      controllerCalls.relaunchAfterRestart += 1;
      await sleep(durations.relaunchEdgeMs);
    },
    hostStartAdoptionLabel: async (label: ServiceLabel): Promise<string> =>
      label.id,
  };
  return {
    ...actual,
    createServiceController: () => controller,
  };
});

let priorExitCode: number | string | null | undefined;
let priorCi: string | undefined;
let priorNonInteractive: string | undefined;
const stdoutChunks: string[] = [];

// Structural handle onto the stdout write spy's call count - narrower than
// `vi.spyOn`'s own return type, so the assignment below is a plain widening,
// never a cast (chained or otherwise).
interface WriteCallCounter {
  readonly mock: { readonly calls: readonly unknown[][] };
}
let stdoutWriteSpy: WriteCallCounter;

// The first import of `host-restart` and the runner transforms their whole
// module graph: seconds of real time on a cold worker, against a few tens of
// milliseconds for each row's own run. It is paid here, once, and not inside
// the budget of whichever row happens to run first. `vi.resetModules()` below
// re-evaluates the modules for each test but keeps them transformed, so each
// row's own import is then warm.
beforeAll(async () => {
  await import("../host-restart");
  await import("../../runner/runner");
});

beforeEach(() => {
  recoveryAction.current = "restart-current";
  supervisorWaitCalls.count = 0;
  spawnEdgeCalls.count = 0;
  spawnEdgeConfig.failFirstCall = true;
  controllerCalls.stopForRestart = 0;
  controllerCalls.relaunchAfterRestart = 0;
  controllerCalls.status = 0;
  stopForRestartMode.kind = "sleep-stop-ladder";
  pidMetadataConfig.mode = "absent";
  pidMetadataConfig.liveRecord = null;
  cooperativeShutdown.pidExitAtMs = null;

  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  // `resolveRuntimeContext` treats CI / TRAYCER_NONINTERACTIVE as an implicit
  // `--no-progress`; this file's whole point is measuring progress lines, so
  // neither may leak in from the ambient test-runner environment.
  priorCi = process.env.CI;
  priorNonInteractive = process.env.TRAYCER_NONINTERACTIVE;
  delete process.env.CI;
  delete process.env.TRAYCER_NONINTERACTIVE;

  stdoutChunks.length = 0;
  sentryMocks.captureException.mockReset();
  sentryMocks.addBreadcrumb.mockReset();
  sentryMocks.close.mockReset().mockResolvedValue(true);
  stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
    callback: (() => void) | undefined,
  ) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    if (callback !== undefined) callback();
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((
    _chunk: string | Uint8Array,
    callback: (() => void) | undefined,
  ) => {
    if (callback !== undefined) callback();
    return true;
  }) as never);
  // Module state (exit arbitration, the process-fatal flag) is reset by a
  // fresh import per test.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = priorExitCode;
  if (priorCi === undefined) delete process.env.CI;
  else process.env.CI = priorCi;
  if (priorNonInteractive === undefined)
    delete process.env.TRAYCER_NONINTERACTIVE;
  else process.env.TRAYCER_NONINTERACTIVE = priorNonInteractive;
});

interface NdjsonLine {
  readonly type: string;
  readonly [key: string]: unknown;
}

function parseNdjsonLines(): NdjsonLine[] {
  const lines: NdjsonLine[] = [];
  for (const raw of stdoutChunks.join("").split("\n")) {
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === "object") {
      lines.push(parsed as NdjsonLine);
    }
  }
  return lines;
}

function maxGap(timestamps: readonly number[]): number {
  let max = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    const gap = timestamps[index] - timestamps[index - 1];
    if (gap > max) max = gap;
  }
  return max;
}

/**
 * Drives `buildHostRestartCommand(args)` through the REAL `runCommand`
 * (`../../runner/runner`), capturing every NDJSON line and the moment it was
 * written. Fresh dynamic imports (`vi.resetModules()` ran in `beforeEach`)
 * pick up the mocks registered above; `process.stdout.write` is already
 * spied, so each write's `Date.now()` is recorded before the write itself can
 * advance anything.
 *
 * Fake timers advance in small steps until the command settles - never a
 * single huge jump, so every intermediate `await` the command chain performs
 * (including each NDJSON write) gets a turn to run, and never a bare `await`
 * on real time, which fake timers never advance on their own.
 */
async function runUnderFakeTimers(args: {
  ifIdle: boolean;
  force: boolean;
  deferIfParked: boolean;
}): Promise<{ readonly timeline: number[]; readonly lines: NdjsonLine[] }> {
  const { buildHostRestartCommand } = await import("../host-restart");
  const { runCommand } = await import("../../runner/runner");

  const timeline: number[] = [];
  let lastCapturedLineCount = 0;

  vi.useFakeTimers();
  const startedAt = Date.now();
  timeline.push(startedAt);

  const runPromise = runCommand(
    buildHostRestartCommand({ ...args, lifecycleOrigin: "terminal" }),
    {
      json: true,
      quiet: false,
      noProgress: false,
      noBootstrap: true,
    },
  );
  let settled = false;
  runPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  const STEP_MS = 1_000;
  const MAX_STEPS = 2_000; // 2_000_000ms = well over any row's total.
  for (let step = 0; step < MAX_STEPS && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    // Every write since the last check gets Date.now() at the moment we
    // observe it landed - close enough under a synchronous mock write that
    // never itself awaits.
    const currentCallCount = stdoutWriteSpy.mock.calls.length;
    if (currentCallCount > lastCapturedLineCount) {
      for (let i = lastCapturedLineCount; i < currentCallCount; i += 1) {
        timeline.push(Date.now());
      }
      lastCapturedLineCount = currentCallCount;
    }
  }
  if (!settled) {
    throw new Error(
      "the command never settled within the fake-timer advance budget",
    );
  }
  await runPromise;
  timeline.push(Date.now());

  const lines = parseNdjsonLines();
  return { timeline, lines };
}

describe("host restart emits no progress across its longest waits (wall-clock residual)", () => {
  it("(g1) fully stacked: stop, an unacknowledged relaunch, reads, two refused-supervisor waits, then a second relaunch - one gap spans nearly the whole run", async () => {
    recoveryAction.current = "restart-current";
    spawnEdgeConfig.failFirstCall = true;
    stopForRestartMode.kind = "sleep-stop-ladder";

    const { timeline, lines } = await runUnderFakeTimers({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });

    expect(lines.length).toBeGreaterThan(0);
    const last = lines[lines.length - 1];
    expect(last.type).toBe("result");
    const data = (last.data ?? {}) as { readonly restarted: boolean };
    expect(data.restarted).toBe(true);
    expect(controllerCalls.stopForRestart).toBe(1);
    expect(controllerCalls.relaunchAfterRestart).toBe(2);
    expect(supervisorWaitCalls.count).toBe(2);

    const gap = maxGap(timeline);
    expect(gap, `longest silent window ${gap} ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });

  it("(g2) plain: stop, then relaunch #1 acknowledged on the first try - still one gap over the ceiling", async () => {
    recoveryAction.current = "restart-current";
    spawnEdgeConfig.failFirstCall = false;
    stopForRestartMode.kind = "sleep-stop-ladder";

    const { timeline, lines } = await runUnderFakeTimers({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });

    expect(lines.length).toBeGreaterThan(0);
    const last = lines[lines.length - 1];
    expect(last.type).toBe("result");
    const data = (last.data ?? {}) as { readonly restarted: boolean };
    expect(data.restarted).toBe(true);
    expect(controllerCalls.stopForRestart).toBe(1);
    expect(controllerCalls.relaunchAfterRestart).toBe(1);
    expect(supervisorWaitCalls.count).toBe(0);

    const gap = maxGap(timeline);
    expect(gap, `longest silent window ${gap} ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });

  it("(g3 control) deferIfParked with a stop-only record touches nothing - one short gap, well under the ceiling", async () => {
    recoveryAction.current = "stop-only";
    stopForRestartMode.kind = "sleep-stop-ladder";

    const { timeline, lines } = await runUnderFakeTimers({
      ifIdle: false,
      force: false,
      deferIfParked: true,
    });

    expect(lines.length).toBeGreaterThan(0);
    const last = lines[lines.length - 1];
    expect(last.type).toBe("result");
    const data = (last.data ?? {}) as {
      readonly restarted: boolean;
      readonly deferredForParkedActivation: boolean;
    };
    expect(data.restarted).toBe(false);
    expect(data.deferredForParkedActivation).toBe(true);
    expect(controllerCalls.stopForRestart).toBe(0);
    expect(controllerCalls.relaunchAfterRestart).toBe(0);

    const gap = maxGap(timeline);
    expect(gap, `longest silent window ${gap} ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });

  it("(g4) a Desktop-owned macOS stop: one controller call spends up to two 225.6s host RPCs plus a late pid exit in a single cooperative stand-down", async () => {
    recoveryAction.current = "restart-current";
    spawnEdgeConfig.failFirstCall = false;
    stopForRestartMode.kind = "cooperative-shutdown";
    pidMetadataConfig.mode = "live";
    pidMetadataConfig.liveRecord = {
      pid: 987_654,
      hostId: "host-restart-progress-gaps-g4",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:57812/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    };
    cooperativeShutdown.pidAliveForMs = 32_000;

    const { timeline, lines } = await runUnderFakeTimers({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });

    expect(lines.length).toBeGreaterThan(0);
    const last = lines[lines.length - 1];
    expect(last.type).toBe("result");
    const data = (last.data ?? {}) as { readonly restarted: boolean };
    expect(data.restarted).toBe(true);
    expect(controllerCalls.stopForRestart).toBe(1);
    expect(controllerCalls.relaunchAfterRestart).toBe(1);

    const gap = maxGap(timeline);
    expect(gap, `longest silent window ${gap} ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });
});
