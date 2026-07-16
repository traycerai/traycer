import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Environment, HostFsLayout } from "../../host/host-paths";
import type {
  HostEnsureError,
  HostEnsureResultPayload,
  HostReadinessResult,
  ServiceLifecycleSnapshot,
} from "../../host/host-readiness";
import type {
  HostLoginItemStatus,
  RegisterHostLoginItemResult,
} from "../../app/host-login-item";

// Ticket packaging-smappservice-activation (issue #287 descriptor-hardening
// review, Finding 3): a busy/indeterminate `desktop-install-cloud.js`
// install preserves the running host instead of booting it out, and leaves
// a pending-revision marker (`~/.traycer/host[/<slot>]/pending-login-item-
// revision.json`) so the *next* `traycerHostEnsure` invocation can apply the
// refreshed SMAppService registration once the host is idle, without
// interrupting in-progress work.
//
// These tests pin `ensureHost`'s already-ready fast path
// (`applyPendingLoginItemRevisionIfIdle`) end to end via the same
// `RunnerIpcBridge` + `handleInvoke` mocking pattern used by
// `host-management-channel.test.ts`, rather than importing the private
// `ensureHost`/`applyPendingLoginItemRevisionIfIdle` functions directly
// (neither is exported - only `registerHostEnsureIpc` is).
//
// NOTE: `local-host-gate.tsx`'s own `traycerHostEnsure` call fires once per
// mount (gated by a ref that never resets), so THIS invocation path has no
// recurring trigger on its own. But `pending-login-item-revision-monitor.ts`
// separately invokes `runEnsureHost` every 30s (via its own tick loop) for as
// long as a pending marker remains and the session isn't quarantined - see
// `pending-login-item-revision-monitor.test.ts` for that recurring-retry
// coverage. These tests deliberately do NOT assert an eventual-retry-while-
// running guarantee for the gate-invoked path - only the single invocation's
// observable behavior for each activity state.

const isHostRemovedByUser: Mock<() => Promise<boolean>> = vi.fn();
vi.mock("../../host/host-removal-state", () => ({
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
vi.mock("../../host/host-lifecycle", () => ({
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
vi.mock("../../host/host-readiness", () => ({
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
vi.mock("../../host/host-paths", () => ({
  getHostFsLayout: (environment: Environment) => getHostFsLayout(environment),
}));

const getActiveEnvironment: Mock<() => Environment> = vi.fn();
const streamCliWithProgress: Mock<(...args: unknown[]) => Promise<unknown>> =
  vi.fn();
vi.mock("../host-management-ipc", () => ({
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

import {
  registerHostEnsureIpc,
  resetPendingRevisionQuarantineForTests,
} from "../host-ensure-ipc";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";

const PID_METADATA_FILE = "/tmp/traycer-host-ensure-ipc-test/pid.json";
const SERVICE_VERSION = "1.2.3";
const SERVICE_LISTEN_URL = "ws://127.0.0.1:9999/rpc";
const SERVICE_PID = 111;

interface FakeServiceStatus {
  readonly state: "running" | "stopped" | "not-installed";
  readonly version: string | null;
  readonly listenUrl: string | null;
  readonly pid: number | null;
}

// `handleInvoke` + `options.host.{getServiceStatus,reloadSnapshotFromDisk}`
// is exactly what `registerHostEnsureIpc`'s fast (already-reachable) path
// dereferences, but `registerHostEnsureIpc(bridge as never)` below still
// needs the cast: `RunnerIpcBridge` is a concrete class with private fields,
// so no plain object - however precisely typed - can structurally satisfy it.
interface FakeBridge {
  readonly handlers: Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >;
  readonly options: {
    readonly host: {
      readonly getServiceStatus: Mock<() => Promise<FakeServiceStatus>>;
      readonly reloadSnapshotFromDisk: Mock<() => Promise<null>>;
    };
  };
  handleInvoke(
    channel: string,
    handler: (event: unknown, raw: unknown) => unknown | Promise<unknown>,
  ): void;
}

function makeBridge(
  getServiceStatus: Mock<() => Promise<FakeServiceStatus>>,
  reloadSnapshotFromDisk: Mock<() => Promise<null>>,
): FakeBridge {
  const handlers = new Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    options: { host: { getServiceStatus, reloadSnapshotFromDisk } },
    handleInvoke(channel, handler) {
      handlers.set(channel, async (event, raw) => handler(event, raw));
    },
  };
}

async function invokeEnsure(): Promise<unknown> {
  const getServiceStatus = vi.fn(() =>
    Promise.resolve({
      state: "running" as const,
      version: SERVICE_VERSION,
      listenUrl: SERVICE_LISTEN_URL,
      pid: SERVICE_PID,
    }),
  );
  const reloadSnapshotFromDisk = vi.fn(() => Promise.resolve(null));
  const bridge = makeBridge(getServiceStatus, reloadSnapshotFromDisk);
  registerHostEnsureIpc(bridge as never);
  const handler = bridge.handlers.get(RunnerHostInvoke.traycerHostEnsure);
  expect(handler).toBeDefined();
  return handler!(null, {});
}

beforeEach(() => {
  resetPendingRevisionQuarantineForTests();
  isHostRemovedByUser.mockReset().mockResolvedValue(false);
  hostManagesHostLoginItem.mockReset().mockResolvedValue(true);
  hasPendingLoginItemRevision.mockReset().mockResolvedValue(false);
  registerHostLoginItem.mockReset().mockResolvedValue("enabled");
  readHostLoginItemStatus.mockReset().mockReturnValue("enabled");
  probeHostActivityBusy.mockReset().mockResolvedValue(false);
  canReachHostWebsocketUrl.mockReset().mockResolvedValue(true);
  waitForHostReady.mockReset().mockResolvedValue({
    ready: true,
    version: "9.9.9",
    pid: 777,
    reason: "ready",
  });
  approvalRequiredMessage
    .mockReset()
    .mockReturnValue("The host's macOS login item requires approval.");
  getHostFsLayout.mockReset().mockReturnValue({
    rootDir: "/tmp/traycer-host-ensure-ipc-test",
    pidMetadataFile: PID_METADATA_FILE,
    logFile: "/tmp/traycer-host-ensure-ipc-test/host.log",
    installDir: "/tmp/traycer-host-ensure-ipc-test/install",
    installRecordFile: "/tmp/traycer-host-ensure-ipc-test/install/install.json",
    pendingLoginItemRevisionFile:
      "/tmp/traycer-host-ensure-ipc-test/pending-login-item-revision.json",
    environment: "production",
  });
  getActiveEnvironment.mockReset().mockReturnValue("production");
  streamCliWithProgress.mockReset();
  categorizeHostCliError.mockReset();
  readServiceLifecycle.mockReset();
});

describe("ensureHost fast path - pending LaunchAgent revision (applyPendingLoginItemRevisionIfIdle)", () => {
  it("reachable host with no pending marker returns the plain already-ready result and never touches SMAppService", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(false);

    const result = await invokeEnsure();

    expect(result).toEqual({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("reachable host with a pending marker while busy leaves already-ready unchanged and never registers", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(true);

    const result = await invokeEnsure();

    expect(result).toEqual({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("reachable host with a pending marker while idle refreshes the SMAppService registration and returns the refreshed pid/version", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("enabled");
    waitForHostReady.mockResolvedValue({
      ready: true,
      version: "9.9.9",
      pid: 777,
      reason: "ready",
    });

    const result = await invokeEnsure();

    expect(result).toEqual({
      action: "already-ready",
      running: true,
      version: "9.9.9",
    });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(waitForHostReady).toHaveBeenCalledWith(
      60_000,
      PID_METADATA_FILE,
      250,
      SERVICE_PID,
    );
  });

  it("throws the approval-required error when the idle refresh cycle ends requires-approval", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("requires-approval");
    approvalRequiredMessage.mockReturnValue(
      "please re-enable Traycer in System Settings",
    );

    await expect(invokeEnsure()).rejects.toThrow(
      "please re-enable Traycer in System Settings",
    );
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("throws the login-item error when the idle refresh cycle ends a non-enabled, non-approval status", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("not-registered");

    await expect(invokeEnsure()).rejects.toThrow(
      /could not be enabled \(status: not-registered\)/,
    );
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("throws the reachability-timeout error when waitForHostReady times out after an idle refresh", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("enabled");
    waitForHostReady.mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      reason: "pid metadata never appeared",
    });

    await expect(invokeEnsure()).rejects.toThrow(
      /did not become reachable in time \(pid metadata never appeared\)/,
    );
  });

  it("skips the destructive cycle entirely when the login item pre-flights as requires-approval - the healthy host is never booted out, and the refresh is quarantined for the session", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    readHostLoginItemStatus.mockReturnValue("requires-approval");

    const result = await invokeEnsure();

    // Only the user can flip the System Settings toggle; running the cycle
    // would bootout (kill) the reachable host and still land back on
    // requires-approval. The fast path must fall through untouched instead.
    expect(result).toEqual({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    // The skip is session-terminal (the monitor keys off this to stop its
    // 30s churn): even after the toggle reads enabled again, no further
    // fast-path refresh runs this session - the marker waits for the next
    // launch.
    readHostLoginItemStatus.mockReturnValue("enabled");
    const second = await invokeEnsure();
    expect(second).toEqual({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("quarantines the refresh for the rest of the session after a cycle that did not land enabled - a second ensure never re-kills the host", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("not-registered");

    await expect(invokeEnsure()).rejects.toThrow(
      /could not be enabled \(status: not-registered\)/,
    );
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);

    // The register cycle's first step is a bootout, so that failed attempt
    // already killed the running host once. A later ensure in the same
    // session (e.g. a 30s monitor tick after the host revived) must not run
    // the cycle again for the same terminal outcome.
    const second = await invokeEnsure();
    expect(second).toEqual({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("returns the removed action when the locked register cycle reports removed-by-user mid-ensure", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("removed-by-user");

    const result = await invokeEnsure();

    expect(result).toEqual({
      action: "removed",
      running: false,
      version: null,
    });
    expect(waitForHostReady).not.toHaveBeenCalled();
  });
});
