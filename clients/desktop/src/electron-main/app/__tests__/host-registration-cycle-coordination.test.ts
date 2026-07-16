import { EventEmitter } from "node:events";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Ticket: registration-cycle-coordinator (issue #287 descriptor-hardening
// review, cohesive review). `host-respawn.ts` used to own a SEPARATE
// in-flight slot from `host-ensure-ipc.ts`'s `runEnsureHost` and called
// `registerHostLoginItem()`'s bootout->unregister->register cycle directly -
// two SMAppService cycles (one via respawn, one via ensure/monitor) could
// interleave and reproduce the exact BTM-stuck ("needs LWCR update")
// condition the whole hardening effort exists to fix. The fix is
// `withHostLoginItemRegistrationLock` in `host-login-item.ts`: every
// `registerHostLoginItem()` call - regardless of caller - now serializes
// through one promise tail.
//
// This file proves that lock holds across the two real call sites using the
// REAL `host-login-item.ts` module (only its `hostManagesHostLoginItem`
// environment gate is stubbed - a leaf boolean probe, not the lock itself)
// and the REAL `respawnHost` / `runEnsureHost` production functions. The
// only OS boundary mocked is `electron`'s LoginItemSettings bridge
// (`app.setLoginItemSettings` / `app.getLoginItemSettings`) - see the
// "INCIDENT" comment below for why `/bin/launchctl`
// itself is kept structurally unreachable (a platform gate, not a subprocess
// mock) rather than mocked directly.
//
// It also closes a real coverage gap: `runEnsureHost`'s own force-
// coalescing state machine (a `force: true` call must never be silently
// served by an in-flight `force: false` op) had no dedicated test anywhere
// in this workspace prior to this file - only the same-force coalescing
// case was covered (`pending-login-item-revision-monitor.test.ts`).

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

interface LoginItemSettings {
  readonly status: string | undefined;
}
interface SetLoginItemSettingsOptions {
  readonly openAtLogin: boolean;
}
const setLoginItemSettingsMock =
  vi.fn<(opts: SetLoginItemSettingsOptions) => void>();
const getLoginItemSettingsMock = vi.fn<() => LoginItemSettings>();
vi.mock("electron", () => ({
  app: {
    setLoginItemSettings: (opts: SetLoginItemSettingsOptions): void =>
      setLoginItemSettingsMock(opts),
    getLoginItemSettings: (): LoginItemSettings => getLoginItemSettingsMock(),
  },
}));

// `host-login-item.ts` computes `HOST_LABEL` from this at import time and
// gates `bootoutStaleAgent` on `!isDevBuild`-independent platform checks -
// keep it minimal and stable across the whole file.
vi.mock("../../../config", () => ({
  config: { environment: "production" },
  isDevBuild: false,
}));

// Only the environment probe is stubbed - `registerHostLoginItem`,
// `unregisterHostLoginItem`, and `withHostLoginItemRegistrationLock` itself
// stay REAL so the mutual-exclusion property under test is exercised for
// real, not asserted against a mock.
const hostManagesHostLoginItemMock = vi.fn<() => Promise<boolean>>();
vi.mock("../host-login-item", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-login-item")>();
  return {
    ...actual,
    hostManagesHostLoginItem: () => hostManagesHostLoginItemMock(),
  };
});

const isHostRemovedByUserMock = vi.fn<() => Promise<boolean>>();
vi.mock("../../host/host-removal-state", () => ({
  isHostRemovedByUser: () => isHostRemovedByUserMock(),
}));

interface HostFsLayoutShape {
  readonly rootDir: string;
  readonly pidMetadataFile: string;
  readonly logFile: string;
  readonly installDir: string;
  readonly installRecordFile: string;
  readonly pendingLoginItemRevisionFile: string;
  readonly environment: string;
}
interface ServiceLabelShape {
  readonly id: string;
  readonly displayName: string;
  readonly appSupportDirName: string;
}
const ROOT = "/tmp/traycer-registration-cycle-coordination-test";
const getHostFsLayoutMock = vi.fn<(environment: string) => HostFsLayoutShape>(
  () => ({
    rootDir: ROOT,
    pidMetadataFile: `${ROOT}/pid.json`,
    logFile: `${ROOT}/host.log`,
    installDir: `${ROOT}/install`,
    installRecordFile: `${ROOT}/install/install.json`,
    pendingLoginItemRevisionFile: `${ROOT}/pending-login-item-revision.json`,
    environment: "production",
  }),
);
const labelForEnvironmentMock = vi.fn<
  (environment: string) => ServiceLabelShape
>(() => ({
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  appSupportDirName: "Traycer",
}));
// Real `host-login-item.ts` imports both of these - mocking the module means
// supplying both, even though only `getHostFsLayout` matters to the
// assertions below (the marker-clear `rm` in `registerHostLoginItem`
// targets a nonexistent path under `force: true`, which is a safe no-op).
vi.mock("../../host/host-paths", () => ({
  getHostFsLayout: (environment: string) => getHostFsLayoutMock(environment),
  labelForEnvironment: (environment: string) =>
    labelForEnvironmentMock(environment),
}));

interface ReadinessResult {
  readonly ready: boolean;
  readonly version: string | null;
  readonly pid: number | null;
  readonly reason: string;
}
const waitForHostReadyMock =
  vi.fn<
    (
      timeoutMs: number,
      pidPath: string,
      pollIntervalMs: number,
      skipPid: number | null,
    ) => Promise<ReadinessResult>
  >();
interface ServiceLifecycleShape {
  readonly priorServiceState: string | null;
  readonly postSwapAction: string | null;
  readonly postSwapError: string | null;
}
const readServiceLifecycleMock =
  vi.fn<(payload: unknown) => ServiceLifecycleShape>();
const categorizeHostCliErrorMock = vi.fn();
vi.mock("../../host/host-readiness", () => ({
  HOST_READY_TIMEOUT_MS: 60_000,
  HOST_READY_POLL_MS: 250,
  waitForHostReady: (
    timeoutMs: number,
    pidPath: string,
    pollIntervalMs: number,
    skipPid: number | null,
  ) => waitForHostReadyMock(timeoutMs, pidPath, pollIntervalMs, skipPid),
  readServiceLifecycle: (payload: unknown) => readServiceLifecycleMock(payload),
  categorizeHostCliError: (err: unknown) => categorizeHostCliErrorMock(err),
}));

const canReachHostWebsocketUrlMock = vi.fn<(url: string) => Promise<boolean>>();
vi.mock("../../host/host-lifecycle", () => ({
  canReachHostWebsocketUrl: (url: string) => canReachHostWebsocketUrlMock(url),
}));

const probeHostActivityBusyMock =
  vi.fn<(listenUrl: string) => Promise<boolean>>();
vi.mock("@traycer-clients/shared/host-client/host-activity-probe", () => ({
  probeHostActivityBusy: (listenUrl: string) =>
    probeHostActivityBusyMock(listenUrl),
}));

const getActiveEnvironmentMock = vi.fn<() => string>();
const streamCliWithProgressMock = vi.fn();
vi.mock("../../ipc/host-management-ipc", () => ({
  getActiveEnvironment: () => getActiveEnvironmentMock(),
  optionalString: (raw: unknown, key: string) => {
    if (raw === null || typeof raw !== "object" || !(key in raw)) return null;
    const value = (raw as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  },
  optionalBoolean: (raw: unknown, key: string) => {
    if (raw === null || typeof raw !== "object" || !(key in raw)) return false;
    return Boolean((raw as Record<string, unknown>)[key]);
  },
  streamCliWithProgress: (...args: unknown[]) =>
    streamCliWithProgressMock(...args),
  LONG_OP_TIMEOUT_MS: 600_000,
}));

// SAFETY BOUNDARY: `process.platform` is forced OFF-darwin - never on, and
// never trusted to a Node-builtin module mock. `bootoutStaleAgent`'s very
// first line is `if (process.platform !== "darwin") return;`, so with this
// forced, `/bin/launchctl` is structurally unreachable from this suite - no
// `spawn`/`node:child_process` mock is in the trust chain at all. This
// mirrors the existing, already-safe pattern in `host-login-item.test.ts`
// (which forces "linux" for the exact same reason). Do NOT change this to
// "darwin" without first threading real spawn injectability through
// `bootoutStaleAgent` in production code (out of this ticket's scope) and
// verifying zero real subprocess calls via a preload spy.
let originalPlatform: PropertyDescriptor | undefined;
let originalResourcesPath: PropertyDescriptor | undefined;
beforeAll(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: "linux",
    writable: true,
    configurable: true,
  });
  originalResourcesPath = Object.getOwnPropertyDescriptor(
    process,
    "resourcesPath",
  );
  Object.defineProperty(process, "resourcesPath", {
    value:
      "/tmp/traycer-registration-cycle-coordination-test/Contents/Resources",
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath;
  } else {
    Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  }
});

// Imported AFTER every mock above so module init evaluates against them.
const { respawnHost } = await import("../host-respawn");
const { runEnsureHost } = await import("../../ipc/host-ensure-ipc");

interface FakeHostServiceStatus {
  state: "running" | "stopped" | "not-installed";
  version: string | null;
  listenUrl: string | null;
  pid: number | null;
}
class FakeHost extends EventEmitter {
  respawnCalls = 0;
  notifyRespawningCalls = 0;
  reloadSnapshotCalls = 0;
  ensureWatcherCalls = 0;
  isDisposed = false;
  readonly pidMetadataFile =
    "/tmp/traycer-registration-cycle-coordination-test/pid.json";
  serviceStatus: FakeHostServiceStatus = {
    state: "running",
    version: "1.0.0",
    listenUrl: "ws://127.0.0.1:1234/rpc",
    pid: 42,
  };
  getSnapshot(): null {
    return null;
  }
  async respawn(): Promise<void> {
    this.respawnCalls += 1;
  }
  notifyRespawning(): void {
    this.notifyRespawningCalls += 1;
  }
  async reloadSnapshotFromDisk(): Promise<null> {
    this.reloadSnapshotCalls += 1;
    return this.getSnapshot();
  }
  ensureWatcherInstalled(): void {
    this.ensureWatcherCalls += 1;
  }
  async getServiceStatus(): Promise<FakeHostServiceStatus> {
    return this.serviceStatus;
  }
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

interface FakeBridgeServiceStatus {
  readonly state: "running" | "stopped" | "not-installed";
  readonly version: string | null;
  readonly listenUrl: string | null;
  readonly pid: number | null;
}
// Every `runEnsureHost(bridge as never, ...)` call site below still needs
// the cast even though this fake is fully typed: `RunnerIpcBridge` is a
// concrete class with private fields, so no plain object - however
// precisely typed - can structurally satisfy it. Only
// `options.host.{getServiceStatus,reloadSnapshotFromDisk}` are ever
// dereferenced on the fast (already-reachable) path these tests exercise.
function fakeBridge(status: FakeBridgeServiceStatus): {
  readonly options: {
    readonly host: {
      readonly getServiceStatus: () => Promise<FakeBridgeServiceStatus>;
      readonly reloadSnapshotFromDisk: () => Promise<null>;
    };
  };
} {
  return {
    options: {
      host: {
        getServiceStatus: () => Promise.resolve(status),
        reloadSnapshotFromDisk: () => Promise.resolve(null),
      },
    },
  };
}

function flushMicrotasks(times: number): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>(
    (chain) => chain.then(() => Promise.resolve()),
    Promise.resolve(),
  );
}

beforeEach(() => {
  setLoginItemSettingsMock.mockReset();
  getLoginItemSettingsMock.mockReset();
  hostManagesHostLoginItemMock.mockReset();
  isHostRemovedByUserMock.mockReset().mockResolvedValue(false);
  getHostFsLayoutMock.mockClear();
  labelForEnvironmentMock.mockClear();
  waitForHostReadyMock.mockReset();
  readServiceLifecycleMock.mockReset();
  categorizeHostCliErrorMock.mockReset();
  canReachHostWebsocketUrlMock.mockReset().mockResolvedValue(true);
  probeHostActivityBusyMock.mockReset().mockResolvedValue(false);
  getActiveEnvironmentMock.mockReset().mockReturnValue("production");
  streamCliWithProgressMock.mockReset();
});

// INCIDENT (2026-07-16, issue #287 registration-cycle-coordinator): an
// earlier revision of this file forced `process.platform = "darwin"` and
// relied on `vi.mock("node:child_process", ...)` as the safety boundary to
// keep `bootoutStaleAgent()` from ever shelling out to the real `launchctl`.
// That mock did not reliably intercept the `spawn` import used inside the
// REAL `host-login-item.ts` (loaded here via `importOriginal`), so with the
// platform forced to darwin the suite executed real
// `/bin/launchctl bootout gui/501/ai.traycer.host` calls, restarting the
// developer's live production host.
//
// This revision removes that unsafe trust boundary entirely: `process.
// platform` is forced OFF-darwin (never on - see the `beforeAll` above), the
// exact same pattern the existing `host-login-item.test.ts` already uses
// safely. `bootoutStaleAgent`'s very first line
// (`if (process.platform !== "darwin") return;`) makes `/bin/launchctl`
// structurally unreachable - there is no subprocess mock in the trust chain
// at all, so nothing can silently fail to intercept it.
//
// With bootout neutralized, the mutual-exclusion proof needs a different
// controllable async gate. `pollRegisterStatusUntilSettled()`'s own retry
// loop provides one for free: it's a REAL (unmocked) `setTimeout`-based
// retry over `readHostLoginItemStatus()` (backed by the mocked, in-memory
// `app.getLoginItemSettings`). Queuing a couple of `"not-registered"`
// responses forces the first cycle to spend ~200ms real (but harmless -
// pure in-process timer, no OS/filesystem/network access) wall-clock time
// inside that loop before it resolves to `"enabled"`. While the first cycle
// is provably still inside that window, a correctly-locked second cycle
// cannot have made its own `setLoginItemSettings` calls yet - proving
// mutual exclusion without ever touching a real subprocess.
describe("shared registration-cycle lock: respawnHost vs runEnsureHost", () => {
  it("never runs two unregister/register cycles at once - the second caller's cycle does not even start until the first fully settles", async () => {
    hostManagesHostLoginItemMock.mockResolvedValue(true);
    getLoginItemSettingsMock
      .mockReturnValueOnce({ status: "not-registered" }) // cycle 1: post-unregister log read
      .mockReturnValueOnce({ status: "not-registered" }) // cycle 1: poll iteration 1 -> real 100ms sleep
      .mockReturnValueOnce({ status: "not-registered" }) // cycle 1: poll iteration 2 -> real 100ms sleep
      .mockReturnValueOnce({ status: "enabled" }) // cycle 1: poll iteration 3 -> settles
      .mockReturnValueOnce({ status: "not-registered" }) // cycle 2: post-unregister log read
      .mockReturnValueOnce({ status: "enabled" }); // cycle 2: poll settles immediately
    setLoginItemSettingsMock.mockReturnValue(undefined);
    waitForHostReadyMock.mockResolvedValue({
      ready: true,
      version: "9.9.9",
      pid: 777,
      reason: "ready",
    });
    readServiceLifecycleMock.mockReturnValue({
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    });
    streamCliWithProgressMock.mockResolvedValue({
      version: "9.9.9",
      serviceLifecycle: { postSwapError: null },
    });

    const respawnFakeHost = new FakeHost();
    const bridge = fakeBridge({
      state: "stopped",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const respawnPromise = respawnHost(respawnFakeHost);
    const ensurePromise = runEnsureHost(
      bridge as never,
      "cross-flow-ensure",
      false,
    );

    await vi.waitFor(
      () => {
        if (setLoginItemSettingsMock.mock.calls.length < 2) {
          throw new Error("waiting for the first cycle's register calls");
        }
      },
      { timeout: 2000 },
    );
    // Exactly one cycle has reached the SMAppService boundary and made its
    // full unregister->register pair; the other caller is still queued
    // behind the lock.
    expect(setLoginItemSettingsMock).toHaveBeenCalledTimes(2);
    expect(setLoginItemSettingsMock.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
    });
    expect(setLoginItemSettingsMock.mock.calls[1]?.[0]).toMatchObject({
      openAtLogin: true,
    });

    // The first cycle is now inside its ~200ms real poll-retry window (two
    // queued "not-registered" responses, each followed by a real 100ms
    // sleep). Sample repeatedly across that guaranteed-open window rather
    // than a single wall-clock sleep + one-shot snapshot: a correctly-locked
    // second cycle cannot have made ANY `setLoginItemSettings` call yet
    // (its `registerHostLoginItemUnserialized()` body has not even started
    // executing - it is still chained behind the first cycle's still-pending
    // promise in `withHostLoginItemRegistrationLock`), and repeated sampling
    // means a single event-loop stall landing on one sample can't by itself
    // make the check pass against a premature second-cycle call.
    const midpointDeadline = Date.now() + 150;
    while (Date.now() < midpointDeadline) {
      expect(setLoginItemSettingsMock).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    }

    await vi.waitFor(
      () => {
        if (setLoginItemSettingsMock.mock.calls.length < 4) {
          throw new Error("waiting for the second cycle's register calls");
        }
      },
      { timeout: 3000 },
    );
    // Only once the first cycle's promise fully settled did the second
    // cycle's own unregister->register pair begin.
    expect(setLoginItemSettingsMock).toHaveBeenCalledTimes(4);

    const [, ensureResult] = await Promise.all([respawnPromise, ensurePromise]);

    expect(ensureResult).toEqual({
      action: "provisioned",
      running: true,
      version: "9.9.9",
    });
    expect(respawnFakeHost.notifyRespawningCalls).toBe(1);
    expect(respawnFakeHost.respawnCalls).toBe(0);
    expect(setLoginItemSettingsMock).toHaveBeenCalledTimes(4);
    expect(getLoginItemSettingsMock).toHaveBeenCalledTimes(6);
  });
});

describe("runEnsureHost force-coalescing (individual semantics unchanged)", () => {
  interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
  }
  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("a force:true call is never silently served by an in-flight force:false op - it waits, then runs its own CLI cycle with --force", async () => {
    // Login-item registration is irrelevant to this state machine - keep it
    // out of the picture so the test isolates `runEnsureHost`'s own
    // in-flight/force bookkeeping.
    hostManagesHostLoginItemMock.mockResolvedValue(false);
    waitForHostReadyMock.mockResolvedValue({
      ready: true,
      version: "irrelevant",
      pid: 1,
      reason: "ready",
    });
    readServiceLifecycleMock.mockReturnValue({
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    });

    const firstCycle = deferred<{
      readonly version: string;
      readonly serviceLifecycle: { readonly postSwapError: string | null };
    }>();
    streamCliWithProgressMock
      .mockImplementationOnce(() => firstCycle.promise)
      .mockImplementationOnce(() =>
        Promise.resolve({
          version: "2.2.2",
          serviceLifecycle: { postSwapError: null },
        }),
      );

    const bridge = fakeBridge({
      state: "stopped",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const nonForcePromise = runEnsureHost(
      bridge as never,
      "op-non-force",
      false,
    );
    await vi.waitFor(() => {
      if (streamCliWithProgressMock.mock.calls.length < 1) {
        throw new Error("waiting for the non-force CLI cycle to start");
      }
    });

    const forcePromise = runEnsureHost(bridge as never, "op-force", true);
    // The force call is deterministically blocked on `while (inFlight !==
    // null) { await inFlight; }` - `firstCycle.promise` is never resolved
    // until this test resolves it, so no amount of extra microtask
    // flushing here can make a second CLI cycle start early.
    await flushMicrotasks(10);
    expect(streamCliWithProgressMock).toHaveBeenCalledTimes(1);

    firstCycle.resolve({
      version: "1.1.1",
      serviceLifecycle: { postSwapError: null },
    });

    const [nonForceResult, forceResult] = await Promise.all([
      nonForcePromise,
      forcePromise,
    ]);

    expect(nonForceResult).toEqual({
      action: "provisioned",
      running: true,
      version: "irrelevant",
    });
    expect(forceResult).toEqual({
      action: "provisioned",
      running: true,
      version: "irrelevant",
    });
    // The force call ran its OWN cycle rather than sharing the non-force
    // result - proof `--force` was never silently dropped.
    expect(streamCliWithProgressMock).toHaveBeenCalledTimes(2);
    const firstArgs = streamCliWithProgressMock.mock.calls[0]?.[0] as
      readonly string[] | undefined;
    const secondArgs = streamCliWithProgressMock.mock.calls[1]?.[0] as
      readonly string[] | undefined;
    expect(firstArgs).not.toContain("--force");
    expect(secondArgs).toContain("--force");
  });

  it("coalesces two force:true callers queued behind an in-flight force:false op onto ONE shared forced cycle, not two separate ones", async () => {
    // Guards against a same-force check that only runs BEFORE the coalescing
    // wait: if it doesn't also apply once dequeued, two force:true callers
    // that both had to wait behind a force:false op could each start their
    // OWN forced cycle instead of sharing one.
    hostManagesHostLoginItemMock.mockResolvedValue(false);
    waitForHostReadyMock.mockResolvedValue({
      ready: true,
      version: "irrelevant",
      pid: 1,
      reason: "ready",
    });
    readServiceLifecycleMock.mockReturnValue({
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    });

    const firstCycle = deferred<{
      readonly version: string;
      readonly serviceLifecycle: { readonly postSwapError: string | null };
    }>();
    streamCliWithProgressMock
      .mockImplementationOnce(() => firstCycle.promise)
      .mockImplementationOnce(() =>
        Promise.resolve({
          version: "3.3.3",
          serviceLifecycle: { postSwapError: null },
        }),
      );

    const bridge = fakeBridge({
      state: "stopped",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const nonForcePromise = runEnsureHost(
      bridge as never,
      "op-non-force",
      false,
    );
    await vi.waitFor(() => {
      if (streamCliWithProgressMock.mock.calls.length < 1) {
        throw new Error("waiting for the non-force CLI cycle to start");
      }
    });

    const forcePromiseA = runEnsureHost(bridge as never, "op-force-a", true);
    const forcePromiseB = runEnsureHost(bridge as never, "op-force-b", true);
    // Both force calls are blocked on the non-force cycle's still-pending
    // promise; no amount of microtask flushing can start a CLI cycle early.
    await flushMicrotasks(10);
    expect(streamCliWithProgressMock).toHaveBeenCalledTimes(1);

    firstCycle.resolve({
      version: "1.1.1",
      serviceLifecycle: { postSwapError: null },
    });

    const [nonForceResult, forceResultA, forceResultB] = await Promise.all([
      nonForcePromise,
      forcePromiseA,
      forcePromiseB,
    ]);

    expect(nonForceResult).toEqual({
      action: "provisioned",
      running: true,
      version: "irrelevant",
    });
    // Exactly one MORE cycle ran (the two force callers shared it) - not two.
    expect(streamCliWithProgressMock).toHaveBeenCalledTimes(2);
    expect(forceResultA).toEqual(forceResultB);
    const secondArgs = streamCliWithProgressMock.mock.calls[1]?.[0] as
      readonly string[] | undefined;
    expect(secondArgs).toContain("--force");
  });

  it("coalesces a second force:false call onto an in-flight force:false op instead of starting a redundant CLI cycle", async () => {
    hostManagesHostLoginItemMock.mockResolvedValue(false);
    waitForHostReadyMock.mockResolvedValue({
      ready: true,
      version: "1.1.1",
      pid: 1,
      reason: "ready",
    });
    readServiceLifecycleMock.mockReturnValue({
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    });
    streamCliWithProgressMock.mockResolvedValue({
      version: "1.1.1",
      serviceLifecycle: { postSwapError: null },
    });

    const bridge = fakeBridge({
      state: "stopped",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const [first, second] = await Promise.all([
      runEnsureHost(bridge as never, "op-a", false),
      runEnsureHost(bridge as never, "op-b", false),
    ]);

    expect(first).toEqual(second);
    expect(streamCliWithProgressMock).toHaveBeenCalledTimes(1);
  });
});
