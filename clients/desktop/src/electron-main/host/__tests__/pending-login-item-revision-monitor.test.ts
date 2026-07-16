import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { HostEnsureIpcResult } from "../../ipc/host-ensure-ipc";
import type { Environment, HostFsLayout } from "../host-paths";
import type {
  HostEnsureError,
  HostEnsureResultPayload,
  HostReadinessResult,
  ServiceLifecycleSnapshot,
} from "../host-readiness";
import type {
  HostLoginItemStatus,
  RegisterHostLoginItemResult,
} from "../../app/host-login-item";

// Ticket packaging-smappservice-activation / marker-monitor: the pending
// LaunchAgent revision monitor closes the gap where `ensureHost()`'s
// already-ready fast path only gets one shot per app launch to apply a
// deferred SMAppService revision - see
// `pending-login-item-revision-monitor.ts`'s module doc comment for the
// full mechanism.
//
// Two independent things are pinned here:
//   - The monitor's own tick logic (guard order, failure budget, dispose
//     semantics) via its deps-injection seams - no module mocking needed,
//     every collaborator is overridable per test.
//   - Mutual exclusion with a concurrent renderer-triggered ensure, which
//     requires the REAL `runEnsureHost` (its in-flight coalescing slot is
//     module-scoped state in `host-ensure-ipc.ts`, not something a fake
//     `deps.runEnsure` could exercise) - that block mocks `ensureHost`'s own
//     dependencies the same way `host-ensure-ipc.test.ts` does.

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: (): string => "/fake/app/path" },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const isHostRemovedByUser: Mock<() => Promise<boolean>> = vi.fn();
vi.mock("../host-removal-state", () => ({
  isHostRemovedByUser: () => isHostRemovedByUser(),
}));

const hostManagesHostLoginItem: Mock<() => Promise<boolean>> = vi.fn();
const hasPendingLoginItemRevision: Mock<
  (environment: Environment) => Promise<boolean>
> = vi.fn();
const registerHostLoginItem: Mock<() => Promise<RegisterHostLoginItemResult>> =
  vi.fn();
const readHostLoginItemStatus: Mock<() => HostLoginItemStatus> = vi.fn();
vi.mock("../../app/host-login-item", () => ({
  hostManagesHostLoginItem: () => hostManagesHostLoginItem(),
  hasPendingLoginItemRevision: (environment: Environment) =>
    hasPendingLoginItemRevision(environment),
  registerHostLoginItem: () => registerHostLoginItem(),
  readHostLoginItemStatus: () => readHostLoginItemStatus(),
}));

const approvalRequiredMessage: Mock<() => string> = vi.fn();
vi.mock("../../app/host-respawn", () => ({
  approvalRequiredMessage: () => approvalRequiredMessage(),
}));

const probeHostActivityBusy: Mock<(websocketUrl: string) => Promise<boolean>> =
  vi.fn();
vi.mock("@traycer-clients/shared/host-client/host-activity-probe", () => ({
  probeHostActivityBusy: (listenUrl: string) =>
    probeHostActivityBusy(listenUrl),
}));

const canReachHostWebsocketUrl: Mock<(url: string) => Promise<boolean>> =
  vi.fn();
vi.mock("../host-lifecycle", () => ({
  canReachHostWebsocketUrl: (url: string) => canReachHostWebsocketUrl(url),
}));

const waitForHostReady: Mock<
  (
    timeoutMs: number,
    pidPath: string,
    pollIntervalMs: number,
    skipPid: number | null,
  ) => Promise<HostReadinessResult>
> = vi.fn();
const categorizeHostCliError: Mock<(err: unknown) => HostEnsureError> = vi.fn();
const readServiceLifecycle: Mock<
  (
    payload: HostEnsureResultPayload | null | undefined,
  ) => ServiceLifecycleSnapshot
> = vi.fn();
vi.mock("../host-readiness", () => ({
  HOST_READY_TIMEOUT_MS: 60_000,
  HOST_READY_POLL_MS: 250,
  categorizeHostCliError: (err: unknown) => categorizeHostCliError(err),
  readServiceLifecycle: (payload: HostEnsureResultPayload | null | undefined) =>
    readServiceLifecycle(payload),
  waitForHostReady: (
    timeoutMs: number,
    pidPath: string,
    pollIntervalMs: number,
    skipPid: number | null,
  ) => waitForHostReady(timeoutMs, pidPath, pollIntervalMs, skipPid),
}));

const getHostFsLayout: Mock<(environment: Environment) => HostFsLayout> =
  vi.fn();
vi.mock("../host-paths", () => ({
  getHostFsLayout: (environment: Environment) => getHostFsLayout(environment),
}));

const getActiveEnvironment: Mock<() => Environment> = vi.fn();
const streamCliWithProgress: Mock<(...args: unknown[]) => Promise<unknown>> =
  vi.fn();
vi.mock("../../ipc/host-management-ipc", () => ({
  getActiveEnvironment: () => getActiveEnvironment(),
  optionalString: (raw: unknown, key: string) => {
    if (raw === null || typeof raw !== "object" || !(key in raw)) {
      return null;
    }
    const value = (raw as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  },
  optionalBoolean: (raw: unknown, key: string) => {
    if (raw === null || typeof raw !== "object" || !(key in raw)) {
      return false;
    }
    return Boolean((raw as Record<string, unknown>)[key]);
  },
  streamCliWithProgress: (...args: unknown[]) => streamCliWithProgress(...args),
  LONG_OP_TIMEOUT_MS: 600_000,
}));

import { startPendingLoginItemRevisionMonitor } from "../pending-login-item-revision-monitor";
import { runEnsureHost } from "../../ipc/host-ensure-ipc";

const INTERVAL_MS = 1_000;
const LISTEN_URL = "ws://127.0.0.1:9999/rpc";
const SERVICE_VERSION = "1.2.3";
const SERVICE_PID = 111;

// `FakeBridge` below is fully typed (no member is `any`/unparameterized), but
// every `runEnsureHost(bridge as never, ...)` call site still needs the cast:
// `RunnerIpcBridge` is a concrete class with private fields, so no plain
// object - however precisely typed - can structurally satisfy it. Only
// `options.host.{getServiceStatus,reloadSnapshotFromDisk}` are ever
// dereferenced on the fast (already-reachable) path these tests exercise.
interface FakeServiceStatus {
  readonly state: "running" | "stopped" | "not-installed";
  readonly version: string | null;
  readonly listenUrl: string | null;
  readonly pid: number | null;
}

interface FakeBridge {
  readonly options: {
    readonly host: {
      readonly getServiceStatus: Mock<() => Promise<FakeServiceStatus>>;
      readonly reloadSnapshotFromDisk: Mock<() => Promise<null>>;
    };
  };
}

function fakeBridge(
  getServiceStatus: Mock<() => Promise<FakeServiceStatus>>,
): FakeBridge {
  return {
    options: {
      host: {
        getServiceStatus,
        reloadSnapshotFromDisk: vi.fn(async () => null),
      },
    },
  };
}

function runningServiceStatus(): Mock<() => Promise<FakeServiceStatus>> {
  return vi.fn(async () => ({
    state: "running" as const,
    version: SERVICE_VERSION,
    listenUrl: LISTEN_URL,
    pid: SERVICE_PID,
  }));
}

describe("startPendingLoginItemRevisionMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function ticks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
  }

  it("runs exactly one register cycle when a marker is present on a reachable host", async () => {
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => ({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    }));
    const bridge = fakeBridge(runningServiceStatus());
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: bridge as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach: vi.fn(async () => true),
      isRefreshQuarantined: () => false,
      runEnsure,
    });
    await ticks(1);
    expect(runEnsure).toHaveBeenCalledTimes(1);
    expect(runEnsure).toHaveBeenCalledWith(bridge, expect.any(String), false);
    monitor.dispose();
  });

  it("short-circuits before any other guard when there is no pending marker", async () => {
    const getServiceStatus = runningServiceStatus();
    const canReach = vi.fn(async () => true);
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => ({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    }));
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(getServiceStatus) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => false),
      canReach,
      isRefreshQuarantined: () => false,
      runEnsure,
    });
    await ticks(3);
    expect(getServiceStatus).not.toHaveBeenCalled();
    expect(canReach).not.toHaveBeenCalled();
    expect(runEnsure).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("does nothing and never provisions when the service is not running", async () => {
    const canReach = vi.fn(async () => true);
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => ({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    }));
    const getServiceStatus = vi.fn(async () => ({
      state: "stopped" as const,
      version: null,
      listenUrl: null,
      pid: null,
    }));
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(getServiceStatus) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach,
      isRefreshQuarantined: () => false,
      runEnsure,
    });
    await ticks(1);
    expect(canReach).not.toHaveBeenCalled();
    expect(runEnsure).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("does nothing when the service reports running but listenUrl is null", async () => {
    const canReach = vi.fn(async () => true);
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => ({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    }));
    const getServiceStatus = vi.fn(async () => ({
      state: "running" as const,
      version: SERVICE_VERSION,
      listenUrl: null,
      pid: SERVICE_PID,
    }));
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(getServiceStatus) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach,
      isRefreshQuarantined: () => false,
      runEnsure,
    });
    await ticks(1);
    expect(canReach).not.toHaveBeenCalled();
    expect(runEnsure).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("does nothing when the host is unreachable", async () => {
    const canReach = vi.fn(async () => false);
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => ({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    }));
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(runningServiceStatus()) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach,
      isRefreshQuarantined: () => false,
      runEnsure,
    });
    await ticks(1);
    expect(canReach).toHaveBeenCalledTimes(1);
    expect(runEnsure).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("exhausts the failure budget after 3 failed attempts and stops every guard check thereafter, permanently", async () => {
    const hasPendingRevision = vi.fn(async () => true);
    const canReach = vi.fn(async () => true);
    const getServiceStatus = runningServiceStatus();
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => {
      throw new Error("register cycle failed");
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(getServiceStatus) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision,
      canReach,
      isRefreshQuarantined: () => false,
      runEnsure,
    });

    await ticks(3);
    expect(runEnsure).toHaveBeenCalledTimes(3);

    hasPendingRevision.mockClear();
    getServiceStatus.mockClear();
    canReach.mockClear();
    runEnsure.mockClear();

    // The 4th tick: budget already exhausted, not even the cheap marker
    // check should run.
    await ticks(1);
    expect(hasPendingRevision).not.toHaveBeenCalled();
    expect(getServiceStatus).not.toHaveBeenCalled();
    expect(canReach).not.toHaveBeenCalled();
    expect(runEnsure).not.toHaveBeenCalled();

    // Never recovers even though every guard would now report favorably.
    await ticks(3);
    expect(hasPendingRevision).not.toHaveBeenCalled();
    expect(runEnsure).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it("increments the failure budget on a thrown guard, not only a runEnsure rejection", async () => {
    const canReach = vi.fn(async () => {
      throw new Error("reachability check failed");
    });
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => ({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    }));
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(runningServiceStatus()) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach,
      isRefreshQuarantined: () => false,
      runEnsure,
    });

    await ticks(3);
    expect(canReach).toHaveBeenCalledTimes(3);
    canReach.mockClear();

    await ticks(1);
    expect(canReach).not.toHaveBeenCalled();
    expect(runEnsure).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it("stops for the session once the ensure fast path has quarantined the refresh - no more handoffs, marker left for the next launch", async () => {
    // Without this terminal check, a quarantined fast path makes every
    // handoff no-op AND resolve `already-ready`: the failure budget resets
    // on each tick and the monitor churns a pointless ensure every 30s for
    // the rest of the session.
    let quarantined = false;
    const hasPendingRevision = vi.fn(async () => true);
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => {
      // Mirrors the real fast path's requires-approval pre-flight: it
      // quarantines and RESOLVES (already-ready) rather than throwing.
      quarantined = true;
      return {
        action: "already-ready",
        running: true,
        version: SERVICE_VERSION,
      };
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(runningServiceStatus()) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision,
      canReach: vi.fn(async () => true),
      isRefreshQuarantined: () => quarantined,
      runEnsure,
    });

    await ticks(1);
    expect(runEnsure).toHaveBeenCalledTimes(1);

    // Every subsequent tick is terminal: no marker probe, no handoff.
    hasPendingRevision.mockClear();
    await ticks(4);
    expect(runEnsure).toHaveBeenCalledTimes(1);
    expect(hasPendingRevision).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it("resets the failure budget after a successful register cycle", async () => {
    let shouldFail = true;
    const runEnsure = vi.fn(async (): Promise<HostEnsureIpcResult> => {
      if (shouldFail) throw new Error("register cycle failed");
      return {
        action: "already-ready",
        running: true,
        version: SERVICE_VERSION,
      };
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(runningServiceStatus()) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach: vi.fn(async () => true),
      isRefreshQuarantined: () => false,
      runEnsure,
    });

    await ticks(2); // 2 failures - budget not yet exhausted (threshold is 3)
    shouldFail = false;
    await ticks(1); // success resets failedAttempts to 0
    shouldFail = true;
    await ticks(3); // a fresh run of 3 failures - should still be allowed to run all 3
    expect(runEnsure).toHaveBeenCalledTimes(6);

    monitor.dispose();
  });

  it("disposing mid-tick stops further ticks and does not crash once the in-flight call resolves", async () => {
    let resolveRunEnsure!: (value: HostEnsureIpcResult) => void;
    const pending = new Promise<HostEnsureIpcResult>((resolve) => {
      resolveRunEnsure = resolve;
    });
    const runEnsure = vi.fn(() => pending);
    const monitor = startPendingLoginItemRevisionMonitor({
      bridge: fakeBridge(runningServiceStatus()) as never,
      intervalMs: INTERVAL_MS,
      environment: "production",
      hasPendingRevision: vi.fn(async () => true),
      canReach: vi.fn(async () => true),
      isRefreshQuarantined: () => false,
      runEnsure,
    });

    // Fires tick 1, which suspends on the still-pending `runEnsure` call.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runEnsure).toHaveBeenCalledTimes(1);

    monitor.dispose();
    resolveRunEnsure({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    // Flush the suspended tick's continuation after resolution.
    await Promise.resolve();
    await Promise.resolve();

    // No further ticks fire - the interval was cleared by dispose().
    await ticks(3);
    expect(runEnsure).toHaveBeenCalledTimes(1);

    // dispose() is idempotent and does not crash when called again.
    expect(() => monitor.dispose()).not.toThrow();
  });
});

describe("mutual exclusion with a concurrent renderer-triggered ensure", () => {
  beforeEach(() => {
    isHostRemovedByUser.mockReset().mockResolvedValue(false);
    hostManagesHostLoginItem.mockReset().mockResolvedValue(true);
    hasPendingLoginItemRevision.mockReset().mockResolvedValue(false);
    registerHostLoginItem.mockReset().mockResolvedValue("enabled");
    readHostLoginItemStatus.mockReset().mockReturnValue("enabled");
    probeHostActivityBusy.mockReset().mockResolvedValue(false);
    canReachHostWebsocketUrl.mockReset().mockResolvedValue(true);
    waitForHostReady.mockReset();
    approvalRequiredMessage.mockReset();
    getHostFsLayout.mockReset();
    getActiveEnvironment.mockReset().mockReturnValue("production");
    streamCliWithProgress.mockReset();
    categorizeHostCliError.mockReset();
    readServiceLifecycle.mockReset();
  });

  it("coalesces the monitor's runEnsureHost call onto a concurrent renderer-triggered one - the underlying cycle runs only once", async () => {
    const getServiceStatus = runningServiceStatus();
    const bridge = fakeBridge(getServiceStatus);

    // Simulates the renderer's `traycerHostEnsure` IPC handler and the
    // monitor's own tick both calling the shared coalescing entry point at
    // the same moment, with matching `force: false`.
    const rendererCall = runEnsureHost(bridge as never, "renderer-op", false);
    const monitorCall = runEnsureHost(bridge as never, "monitor-op", false);

    const [rendererResult, monitorResult] = await Promise.all([
      rendererCall,
      monitorCall,
    ]);

    const expected: HostEnsureIpcResult = {
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    };
    expect(rendererResult).toEqual(expected);
    expect(monitorResult).toEqual(expected);

    // The second caller coalesced onto the first's in-flight promise rather
    // than racing a second, independent register cycle.
    expect(getServiceStatus).toHaveBeenCalledTimes(1);
    expect(canReachHostWebsocketUrl).toHaveBeenCalledTimes(1);
    expect(isHostRemovedByUser).toHaveBeenCalledTimes(1);
    expect(hostManagesHostLoginItem).toHaveBeenCalledTimes(1);
  });
});
