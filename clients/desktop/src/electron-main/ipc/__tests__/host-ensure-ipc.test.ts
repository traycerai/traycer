import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Environment, HostFsLayout } from "../../host/host-paths";
import type { HostPendingRevisionState } from "@traycer-clients/shared/platform/runner-host";
import type {
  HostEnsureError,
  HostEnsureResultPayload,
  HostReadinessResult,
  HostSpawnEvidenceBaseline,
  ServiceLifecycleSnapshot,
} from "../../host/host-readiness";
import type {
  HostLoginItemStatus,
  RegisterHostLoginItemResult,
} from "../../app/host-login-item";
import type { RegisterCycleDecision } from "../../host/host-register-cycle-decision";

vi.mock("../../cli/cli-discovery", () => ({
  resolveBundledCliPath: () => Promise.resolve(null),
}));

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
const registerHostLoginItem: Mock<
  (
    revalidate: (() => Promise<RegisterCycleDecision>) | undefined,
  ) => Promise<RegisterHostLoginItemResult>
> = vi.fn();
const readHostLoginItemStatus: Mock<() => HostLoginItemStatus> = vi.fn();
vi.mock("../../app/host-login-item", () => ({
  HOST_AGENT_LABEL: "ai.traycer.host.agent",
  hostManagesHostLoginItem: () => hostManagesHostLoginItem(),
  hasPendingLoginItemRevision: (environment: Environment) =>
    hasPendingLoginItemRevision(environment),
  registerHostLoginItem: (
    revalidate: (() => Promise<RegisterCycleDecision>) | undefined,
  ) => registerHostLoginItem(revalidate),
  readHostLoginItemStatus: () => readHostLoginItemStatus(),
}));

// The register-cycle state machine is mocked so the rebuilt skip-join wiring
// test can drive the REAL `buildRegisterCycleRevalidate` closure (Mo-C) - which
// computes `cliActionInstalled` from the CLI payload and feeds the machine seams
// - and assert the decision it produces, rather than fabricating an unreachable
// `installed`+`skip-join` combination on a fully-stubbed registerHostLoginItem.
// Only tests that invoke the revalidate consult it; the rest stub
// registerHostLoginItem's result directly.
const evaluateRegisterCycleDecision: Mock<
  (inputs: unknown) => Promise<RegisterCycleDecision>
> = vi.fn();
vi.mock("../../host/host-register-cycle-decision", () => ({
  evaluateRegisterCycleDecision: (inputs: unknown) =>
    evaluateRegisterCycleDecision(inputs),
}));

// The fast-path gate and the register-cycle machine seam read the pending state
// from `../../host/pending-login-item-revision` (M-A/M-B). Mock it and drive the
// gate through the same knob the login-item mock exposes so a single
// `hasPendingLoginItemRevision.mockResolvedValue(...)` still controls "is there
// a pending revision" across the whole flow.
const hasPendingLoginItemRevisionOrPendingCycle: Mock<
  (environment: Environment) => Promise<boolean>
> = vi.fn();
const hasUnappliedPendingLoginItemRevision: Mock<
  (environment: Environment) => Promise<boolean>
> = vi.fn();
const isPendingCycleFlagSet: Mock<(environment: Environment) => boolean> =
  vi.fn();
const writePendingLoginItemRevision: Mock<
  (environment: Environment, cause: string) => Promise<HostPendingRevisionState>
> = vi.fn();
vi.mock("../../host/pending-login-item-revision", () => ({
  hasPendingLoginItemRevisionOrPendingCycle: (environment: Environment) =>
    hasPendingLoginItemRevisionOrPendingCycle(environment),
  hasUnappliedPendingLoginItemRevision: (environment: Environment) =>
    hasUnappliedPendingLoginItemRevision(environment),
  isPendingCycleFlagSet: (environment: Environment) =>
    isPendingCycleFlagSet(environment),
  writePendingLoginItemRevision: (environment: Environment, cause: string) =>
    writePendingLoginItemRevision(environment, cause),
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
    options: {
      spawnEvidenceBaseline: unknown;
      extendedTimeoutMs: number;
    },
  ) => Promise<HostReadinessResult>
> = vi.fn();
const categorizeHostCliError: Mock<(err: unknown) => HostEnsureError> = vi.fn();
const readServiceLifecycle: Mock<
  (
    payload: HostEnsureResultPayload | null | undefined,
  ) => ServiceLifecycleSnapshot
> = vi.fn();
const captureHostSpawnEvidenceBaseline: Mock<
  (
    logPath: string,
    pidPath: string,
  ) => Promise<HostSpawnEvidenceBaseline | null>
> = vi.fn();
vi.mock("../../host/host-readiness", () => ({
  HOST_READY_TIMEOUT_MS: 60_000,
  HOST_READY_POLL_MS: 250,
  HOST_READY_EXTENDED_TIMEOUT_MS: 5 * 60_000,
  buildDarwinAgentAuthority: () => Promise.resolve(null),
  categorizeHostCliError: (err: unknown) => categorizeHostCliError(err),
  readServiceLifecycle: (payload: HostEnsureResultPayload | null | undefined) =>
    readServiceLifecycle(payload),
  captureHostSpawnEvidenceBaseline: (logPath: string, pidPath: string) =>
    captureHostSpawnEvidenceBaseline(logPath, pidPath),
  waitForHostReady: (
    timeoutMs: number,
    pidPath: string,
    pollIntervalMs: number,
    skipPid: number | null,
    options: {
      spawnEvidenceBaseline: unknown;
      extendedTimeoutMs: number;
    },
  ) => waitForHostReady(timeoutMs, pidPath, pollIntervalMs, skipPid, options),
}));

const getHostFsLayout: Mock<(environment: Environment) => HostFsLayout> =
  vi.fn();
vi.mock("../../host/host-paths", () => ({
  getHostFsLayout: (environment: Environment) => getHostFsLayout(environment),
}));

const getActiveEnvironment: Mock<() => Environment> = vi.fn();
const streamCliWithinReservedOperation: Mock<
  (...args: unknown[]) => Promise<unknown>
> = vi.fn();

type HostOperationKind =
  | "install"
  | "update"
  | "register-service"
  | "ensure"
  | "restart"
  | "free-port-and-restart";

interface HostOperationStatus {
  readonly operationId: string;
  readonly kind: HostOperationKind;
  readonly stage: string | null;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
  readonly startedAt: string;
}

type HostEnsureOutcome =
  | {
      readonly operationId: string;
      readonly revision: number;
      readonly result: {
        readonly action:
          "already-ready" | "provisioned" | "host-busy" | "removed";
        readonly running: boolean;
        readonly version: string | null;
      };
      readonly busyHostPid: number | null;
    }
  | {
      readonly operationId: string;
      readonly revision: number;
      readonly error: {
        readonly message: string;
        readonly code: string | null;
      };
    }
  | null;

interface HostOperationStatusEnvelope {
  revision: number;
  status: HostOperationStatus | null;
  lastEnsureOutcome: HostEnsureOutcome;
}

interface HostOperationReservation {
  readonly bridge: {
    fanOut: Mock<(channel: string, payload: unknown) => void>;
  };
  readonly operationId: string;
  readonly kind: HostOperationKind;
  readonly startedAt: string;
  readonly cancelEpoch: number;
}

type PendingEnsureOutcome =
  | {
      readonly operationId: string;
      readonly result: {
        readonly action:
          "already-ready" | "provisioned" | "host-busy" | "removed";
        readonly running: boolean;
        readonly version: string | null;
      };
      readonly busyHostPid: number | null;
    }
  | {
      readonly operationId: string;
      readonly error: {
        readonly message: string;
        readonly code: string | null;
      };
    }
  | null;

// Faithful mocked seam for the T2 revisioned envelope + whole-ensure
// reservation. Mirrors main's monotonic revision / settle-and-retain rules so
// join-only admission can be exercised without booting real CLI hosts.
let currentEnvelope: HostOperationStatusEnvelope = {
  revision: 0,
  status: null,
  lastEnsureOutcome: null,
};

function resetEnvelopeSeam(): void {
  currentEnvelope = {
    revision: 0,
    status: null,
    lastEnsureOutcome: null,
  };
}

function setEnvelope(
  bridge: HostOperationReservation["bridge"],
  status: HostOperationStatus | null,
  pendingEnsureOutcome: PendingEnsureOutcome,
): HostOperationStatusEnvelope {
  const revision = currentEnvelope.revision + 1;
  const lastEnsureOutcome: HostEnsureOutcome =
    pendingEnsureOutcome === null
      ? null
      : "result" in pendingEnsureOutcome
        ? {
            operationId: pendingEnsureOutcome.operationId,
            revision,
            result: pendingEnsureOutcome.result,
            busyHostPid: pendingEnsureOutcome.busyHostPid,
          }
        : {
            operationId: pendingEnsureOutcome.operationId,
            revision,
            error: pendingEnsureOutcome.error,
          };
  currentEnvelope = { revision, status, lastEnsureOutcome };
  bridge.fanOut("hostOperationStatusChange", currentEnvelope);
  return currentEnvelope;
}

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
    return (raw as Record<string, unknown>)[key] === true;
  },
  getHostOperationStatus: () => currentEnvelope,
  reserveHostOperation: (
    bridge: HostOperationReservation["bridge"],
    kind: HostOperationKind,
    operationId: string,
  ): HostOperationReservation => {
    if (currentEnvelope.status !== null) {
      throw new Error(
        `Another host operation (${currentEnvelope.status.kind}) is already in progress`,
      );
    }
    const reservation: HostOperationReservation = {
      bridge,
      operationId,
      kind,
      startedAt: "2026-05-15T00:00:00Z",
      cancelEpoch: 0,
    };
    setEnvelope(
      bridge,
      {
        operationId,
        kind,
        stage: null,
        percent: null,
        bytes: null,
        totalBytes: null,
        message: null,
        startedAt: reservation.startedAt,
      },
      null,
    );
    return reservation;
  },
  publishHostOperationStage: (
    reservation: HostOperationReservation,
    stage: string,
  ): void => {
    const status = currentEnvelope.status;
    if (status === null || status.operationId !== reservation.operationId) {
      throw new Error(
        "Host operation reservation was lost before it completed",
      );
    }
    setEnvelope(
      reservation.bridge,
      {
        ...status,
        stage,
        percent: null,
        bytes: null,
        totalBytes: null,
        message: null,
      },
      null,
    );
  },
  releaseHostOperation: (
    reservation: HostOperationReservation,
    pendingEnsureOutcome: PendingEnsureOutcome,
  ): void => {
    const status = currentEnvelope.status;
    if (status === null || status.operationId !== reservation.operationId) {
      throw new Error(
        "Host operation reservation was lost before it completed",
      );
    }
    setEnvelope(reservation.bridge, null, pendingEnsureOutcome);
  },
  streamCliWithinReservedOperation: (...args: unknown[]) =>
    streamCliWithinReservedOperation(...args),
  LONG_OP_TIMEOUT_MS: 600_000,
}));

import {
  registerHostEnsureIpc,
  resetInFlightEnsureForTests,
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

interface FakeHostSnapshot {
  readonly pid: number;
  readonly hostId: string;
  readonly websocketUrl: string;
  readonly version: string;
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
  readonly fanOut: Mock<(channel: string, payload: unknown) => void>;
  readonly options: {
    readonly host: {
      readonly getServiceStatus: Mock<() => Promise<FakeServiceStatus>>;
      readonly reloadSnapshotFromDisk: Mock<
        () => Promise<FakeHostSnapshot | null>
      >;
      readonly getSnapshot: Mock<() => FakeHostSnapshot | null>;
    };
  };
  handleInvoke(
    channel: string,
    handler: (event: unknown, raw: unknown) => unknown | Promise<unknown>,
  ): void;
}

function makeBridge(
  getServiceStatus: Mock<() => Promise<FakeServiceStatus>>,
  reloadSnapshotFromDisk: Mock<() => Promise<FakeHostSnapshot | null>>,
  getSnapshot: Mock<() => FakeHostSnapshot | null>,
): FakeBridge {
  const handlers = new Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    fanOut: vi.fn(),
    options: {
      host: { getServiceStatus, reloadSnapshotFromDisk, getSnapshot },
    },
    handleInvoke(channel, handler) {
      handlers.set(channel, async (event, raw) => handler(event, raw));
    },
  };
}

function registerEnsure(
  bridge: FakeBridge,
): (raw: unknown) => Promise<unknown> {
  registerHostEnsureIpc(bridge as never);
  const handler = bridge.handlers.get(RunnerHostInvoke.traycerHostEnsure);
  expect(handler).toBeDefined();
  return (raw) => handler!(null, raw);
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
  const getSnapshot = vi.fn(() => null);
  const bridge = makeBridge(
    getServiceStatus,
    reloadSnapshotFromDisk,
    getSnapshot,
  );
  return registerEnsure(bridge)({});
}

beforeEach(() => {
  resetPendingRevisionQuarantineForTests();
  resetInFlightEnsureForTests();
  resetEnvelopeSeam();
  isHostRemovedByUser.mockReset().mockResolvedValue(false);
  hostManagesHostLoginItem.mockReset().mockResolvedValue(true);
  hasPendingLoginItemRevision.mockReset().mockResolvedValue(false);
  // Route both the fast-path gate (marker∨flag) and the machine's marker seam
  // through the single `hasPendingLoginItemRevision` knob by default; individual
  // tests can override to exercise the flag-only (M-A) or applied (M-B) cases.
  hasPendingLoginItemRevisionOrPendingCycle
    .mockReset()
    .mockImplementation((environment) =>
      hasPendingLoginItemRevision(environment),
    );
  hasUnappliedPendingLoginItemRevision
    .mockReset()
    .mockImplementation((environment) =>
      hasPendingLoginItemRevision(environment),
    );
  isPendingCycleFlagSet.mockReset().mockReturnValue(false);
  writePendingLoginItemRevision.mockReset().mockResolvedValue({
    pending: true,
    durable: true,
    cause: null,
    error: null,
  });
  // Consulted only when a test wires registerHostLoginItem to invoke the real
  // revalidate (the Mo-C skip-join wiring tests); harmless for the rest.
  evaluateRegisterCycleDecision
    .mockReset()
    .mockResolvedValue({ kind: "cycle", causes: ["stamp-mismatch"] });
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
    registrationStampFile:
      "/tmp/traycer-host-ensure-ipc-test/registration-stamp.json",
    environment: "production",
  });
  getActiveEnvironment.mockReset().mockReturnValue("production");
  streamCliWithinReservedOperation.mockReset();
  categorizeHostCliError.mockReset();
  readServiceLifecycle.mockReset();
  captureHostSpawnEvidenceBaseline.mockReset().mockResolvedValue(null);
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
      {
        spawnEvidenceBaseline: null,
        extendedTimeoutMs: 5 * 60_000,
        darwinAgentAuthority: null,
      },
    );
  });

  it("M-A: a flag-only deferral (in-memory pending-cycle flag, NO disk marker) still applies on the idle fast path", async () => {
    // The register cycle deferred while busy and its marker WRITE failed, leaving
    // only the in-memory pending-cycle flag - no disk trace. The 30s monitor
    // wakes on marker∨flag, so the fast path must apply this too: a disk-only
    // gate returned null here and stranded the repair until a full relaunch
    // while churning a no-op every tick (M-A).
    hasPendingLoginItemRevision.mockResolvedValue(false); // no on-disk marker
    isPendingCycleFlagSet.mockReturnValue(true);
    hasPendingLoginItemRevisionOrPendingCycle.mockResolvedValue(true); // marker∨flag
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
    // Exactly one register cycle applied the deferred repair.
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
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

async function invokeEnsureWithServiceStatus(
  status: FakeServiceStatus,
): Promise<unknown> {
  const getServiceStatus = vi.fn(() => Promise.resolve(status));
  const reloadSnapshotFromDisk = vi.fn(() => Promise.resolve(null));
  const getSnapshot = vi.fn(() => null);
  const bridge = makeBridge(
    getServiceStatus,
    reloadSnapshotFromDisk,
    getSnapshot,
  );
  return registerEnsure(bridge)({});
}

describe("ensureHost running:false readiness gating (CLI-registered cohort only)", () => {
  const stoppedStatus: FakeServiceStatus = {
    state: "stopped",
    version: null,
    listenUrl: null,
    pid: null,
  };

  it("routes CLI-owned running:false into evidence-gated readiness", async () => {
    hostManagesHostLoginItem.mockResolvedValue(false);
    readServiceLifecycle.mockReturnValue({
      priorServiceState: "stopped",
      postSwapAction: "start",
      postSwapError: null,
    });
    streamCliWithinReservedOperation.mockResolvedValue({
      action: "started",
      running: false,
      registered: true,
      version: "1.5.0",
      serviceLifecycle: {
        priorServiceState: "stopped",
        postSwapAction: "start",
        postSwapError: null,
      },
    });

    const result = await invokeEnsureWithServiceStatus(stoppedStatus);

    expect(result).toEqual({
      action: "provisioned",
      running: true,
      version: "9.9.9",
    });
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("still proceeds to SMAppService register + readiness when hostOwnsLoginItem and running:false", async () => {
    hostManagesHostLoginItem.mockResolvedValue(true);
    readServiceLifecycle.mockReturnValue({
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    });
    // running:false is expected on the SMAppService path — desktop starts
    // the host after CLI installs bytes with --no-service-register.
    streamCliWithinReservedOperation.mockResolvedValue({
      action: "installed",
      running: false,
      registered: false,
      version: "1.5.0",
      serviceLifecycle: null,
    });
    registerHostLoginItem.mockResolvedValue("enabled");
    waitForHostReady.mockResolvedValue({
      ready: true,
      version: "1.5.0",
      pid: 4242,
      reason: "ready",
    });

    const result = await invokeEnsureWithServiceStatus(stoppedStatus);

    expect(result).toEqual({
      action: "provisioned",
      running: true,
      version: "1.5.0",
    });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
  });

  it("wires a non-null win32 baseline into the readiness wait after CLI ensure", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    try {
      const baseline: HostSpawnEvidenceBaseline = {
        logPath: "/tmp/host.log",
        logExists: true,
        logSize: 12,
        logDev: 1,
        logIno: 2,
        pidPath: PID_METADATA_FILE,
        pidExists: true,
        pidMtimeMs: 100,
        pid: 7,
        markerAuthoritySinceMs: null,
      };
      hostManagesHostLoginItem.mockResolvedValue(false);
      captureHostSpawnEvidenceBaseline.mockResolvedValue(baseline);
      readServiceLifecycle.mockReturnValue({
        priorServiceState: "stopped",
        postSwapAction: "start",
        postSwapError: null,
      });
      streamCliWithinReservedOperation.mockResolvedValue({
        action: "started",
        running: false,
        registered: true,
        version: "1.5.0",
      });

      await invokeEnsureWithServiceStatus(stoppedStatus);

      expect(captureHostSpawnEvidenceBaseline).toHaveBeenCalledWith(
        "/tmp/traycer-host-ensure-ipc-test/host.log",
        PID_METADATA_FILE,
      );
      expect(waitForHostReady).toHaveBeenCalledWith(
        60_000,
        PID_METADATA_FILE,
        250,
        null,
        expect.objectContaining({
          spawnEvidenceBaseline: expect.objectContaining({
            logPath: "/tmp/host.log",
            markerAuthoritySinceMs: expect.any(Number),
          }),
        }),
      );
    } finally {
      if (originalPlatform !== undefined) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});

describe("ensureHost full-install skip-join wiring (Finding F / T6)", () => {
  const runningStatus: FakeServiceStatus = {
    state: "running",
    version: SERVICE_VERSION,
    listenUrl: SERVICE_LISTEN_URL,
    pid: SERVICE_PID,
  };

  // Shared full-install setup: a host is RUNNING but its endpoint is
  // unreachable, so the ensure falls through the reachable fast path and runs a
  // full install + SMAppService register cycle with prePid = the running pid.
  // `cliAction` drives the CLI payload's `action` so the REAL revalidate sees a
  // realistic `cliActionInstalled` (Mo-C): "installed" for a fresh install,
  // "up-to-date" for the reachable no-op that legitimately yields skip-join.
  function primeUnreachableRunningEnsure(cliAction: string): void {
    canReachHostWebsocketUrl.mockResolvedValue(false);
    readServiceLifecycle.mockReturnValue({
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    });
    streamCliWithinReservedOperation.mockResolvedValue({
      action: cliAction,
      running: false,
      registered: false,
      version: "1.5.0",
      serviceLifecycle: null,
    });
  }

  // Route registerHostLoginItem through its REAL decision mapping: invoke the
  // revalidate closure host-ensure built and translate the machine's decision
  // exactly as the production helper does. This exercises the actual wiring
  // (CLI payload -> cliActionInstalled -> machine -> status) instead of stubbing
  // a status the machine could never have produced for that payload (Mo-C).
  function wireRegisterToRealRevalidate(): void {
    registerHostLoginItem.mockImplementation(async (revalidate) => {
      if (revalidate === undefined) return "enabled";
      const decision = await revalidate();
      switch (decision.kind) {
        case "skip-join":
          return "skip-join";
        case "defer-busy":
          return "deferred-busy";
        case "defer-busy-unpersisted":
          return "deferred-busy-unpersisted";
        case "cycle":
          return "enabled";
      }
    });
  }

  it("skip-join (a reachable no-op: viable spawn, no definition change) makes readiness JOIN the running spawn (skipPid null)", async () => {
    // The register cycle finds a viable current-generation agent spawn and
    // nothing to apply, so the REAL machine returns skip-join - reachable ONLY
    // for a non-install CLI action (an "installed" payload is a definitionChange
    // and would cycle). Readiness must then JOIN it: skipPid=null accepts the
    // current pid rather than skipping the only host there is.
    primeUnreachableRunningEnsure("up-to-date");
    wireRegisterToRealRevalidate();
    evaluateRegisterCycleDecision.mockResolvedValue({ kind: "skip-join" });
    waitForHostReady.mockResolvedValue({
      ready: true,
      version: "1.5.0",
      pid: SERVICE_PID,
      reason: "ready",
    });

    const result = await invokeEnsureWithServiceStatus(runningStatus);

    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    // The decision was reached from a REACHABLE state: the real revalidate fed
    // the machine cliActionInstalled=false (no install => no definitionChange).
    expect(evaluateRegisterCycleDecision).toHaveBeenCalledWith(
      expect.objectContaining({ cliActionInstalled: false }),
    );
    // The load-bearing wiring: skip-join => joinExistingSpawn => skipPid null.
    expect(waitForHostReady).toHaveBeenCalledWith(
      60_000,
      PID_METADATA_FILE,
      250,
      null,
      expect.anything(),
    );
    expect(result).toEqual({
      action: "provisioned",
      running: true,
      version: "1.5.0",
    });
  });

  it("an installed payload drives the machine to CYCLE (enabled) and readiness skips the stale prePid - the contrast that makes the null load-bearing", async () => {
    // A fresh install IS a definitionChange, so the real revalidate feeds the
    // machine cliActionInstalled=true and it cycles. The old host is booted out;
    // its lingering pid.json now belongs to the displaced host, so readiness
    // MUST skip prePid and wait for the freshly spawned process. Pairing this
    // with the skip-join case pins the `joinExistingSpawn ? null : prePid`
    // wiring from both sides, both from reachable machine decisions.
    primeUnreachableRunningEnsure("installed");
    wireRegisterToRealRevalidate();
    evaluateRegisterCycleDecision.mockResolvedValue({
      kind: "cycle",
      causes: ["action-installed"],
    });
    waitForHostReady.mockResolvedValue({
      ready: true,
      version: "1.5.0",
      pid: 4242,
      reason: "ready",
    });

    await invokeEnsureWithServiceStatus(runningStatus);

    expect(evaluateRegisterCycleDecision).toHaveBeenCalledWith(
      expect.objectContaining({ cliActionInstalled: true }),
    );
    expect(waitForHostReady).toHaveBeenCalledWith(
      60_000,
      PID_METADATA_FILE,
      250,
      SERVICE_PID,
      expect.anything(),
    );
  });
});

describe("T2 whole-ensure reservation + revisioned envelope", () => {
  const runningStatus: FakeServiceStatus = {
    state: "running",
    version: SERVICE_VERSION,
    listenUrl: SERVICE_LISTEN_URL,
    pid: SERVICE_PID,
  };

  function makeRunningBridge(snapshot: FakeHostSnapshot | null): {
    readonly bridge: FakeBridge;
    readonly ensure: (raw: unknown) => Promise<unknown>;
  } {
    const getServiceStatus = vi.fn(() => Promise.resolve(runningStatus));
    const reloadSnapshotFromDisk = vi.fn(() => Promise.resolve(snapshot));
    const getSnapshot = vi.fn(() => snapshot);
    const bridge = makeBridge(
      getServiceStatus,
      reloadSnapshotFromDisk,
      getSnapshot,
    );
    return { bridge, ensure: registerEnsure(bridge) };
  }

  it("keeps the ensure reservation alive through pending-marker apply + readiness stages", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("enabled");
    waitForHostReady.mockImplementation(async () => {
      expect(currentEnvelope.status).toMatchObject({
        kind: "ensure",
        stage: "waiting-ready",
      });
      return {
        ready: true,
        version: "9.9.9",
        pid: 777,
        reason: "ready",
      };
    });
    const { bridge, ensure } = makeRunningBridge(null);

    const resultPromise = ensure({ operationId: "op-pending" });
    await Promise.resolve();
    // Applying is published before waitForHostReady; reservation must still
    // own the envelope while native readiness runs.
    expect(currentEnvelope.status?.kind).toBe("ensure");
    await expect(resultPromise).resolves.toEqual({
      action: "already-ready",
      running: true,
      version: "9.9.9",
    });
    expect(currentEnvelope.status).toBeNull();
    expect(currentEnvelope.lastEnsureOutcome).toMatchObject({
      operationId: "op-pending",
      result: {
        action: "already-ready",
        running: true,
        version: "9.9.9",
      },
    });
    expect(bridge.fanOut).toHaveBeenCalled();
    const envelopes = bridge.fanOut.mock.calls
      .map(([, payload]) => payload as HostOperationStatusEnvelope)
      .filter((payload) => payload !== null && typeof payload === "object");
    expect(envelopes.some((e) => e.status?.stage === "applying")).toBe(true);
    expect(envelopes.some((e) => e.status?.stage === "waiting-ready")).toBe(
      true,
    );
  });

  it("settles and retains success atomically with a revision bump (status null + outcome same revision)", async () => {
    const { ensure } = makeRunningBridge(null);
    const before = currentEnvelope.revision;
    await ensure({ operationId: "op-ready" });
    expect(currentEnvelope.status).toBeNull();
    expect(currentEnvelope.lastEnsureOutcome).toMatchObject({
      operationId: "op-ready",
      revision: currentEnvelope.revision,
      result: {
        action: "already-ready",
        running: true,
        version: SERVICE_VERSION,
      },
    });
    expect(currentEnvelope.revision).toBeGreaterThan(before);
  });

  it("join-only observed ensure returns retained success without launching work", async () => {
    const { ensure } = makeRunningBridge(null);
    await ensure({ operationId: "op-join-success" });
    streamCliWithinReservedOperation.mockClear();
    hasPendingLoginItemRevision.mockClear();

    const joined = await ensure({
      observedOperationId: "op-join-success",
    });
    expect(joined).toEqual({
      action: "already-ready",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(streamCliWithinReservedOperation).not.toHaveBeenCalled();
    expect(hasPendingLoginItemRevision).not.toHaveBeenCalled();
  });

  it("join-only retained error rejects and never resolves a success result", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("not-registered");
    const { ensure } = makeRunningBridge(null);

    await expect(ensure({ operationId: "op-join-error" })).rejects.toThrow(
      /could not be enabled \(status: not-registered\)/,
    );
    expect(currentEnvelope.lastEnsureOutcome).toMatchObject({
      operationId: "op-join-error",
      error: expect.objectContaining({
        message: expect.stringMatching(/could not be enabled/),
      }),
    });
    resetPendingRevisionQuarantineForTests();
    hasPendingLoginItemRevision.mockClear();
    registerHostLoginItem.mockClear();

    await expect(
      ensure({ observedOperationId: "op-join-error" }),
    ).rejects.toThrow(/could not be enabled \(status: not-registered\)/);
    expect(hasPendingLoginItemRevision).not.toHaveBeenCalled();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("active join shares the in-flight promise; late join after a newer op is superseded", async () => {
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("enabled");
    waitForHostReady.mockImplementation(async () => {
      await readyGate;
      return {
        ready: true,
        version: "9.9.9",
        pid: 777,
        reason: "ready",
      };
    });
    const { ensure } = makeRunningBridge(null);

    const first = ensure({ operationId: "op-active" });
    const joinActive = ensure({ observedOperationId: "op-active" });
    // Let the first ensure enter readiness before releasing.
    await Promise.resolve();
    releaseReady();
    await expect(first).resolves.toEqual({
      action: "already-ready",
      running: true,
      version: "9.9.9",
    });
    await expect(joinActive).resolves.toEqual({
      action: "already-ready",
      running: true,
      version: "9.9.9",
    });

    // A different active ensure must not be joined by the old operation id.
    let releaseNextReady!: () => void;
    let markNextReadyEntered!: () => void;
    const nextReadyGate = new Promise<void>((resolve) => {
      releaseNextReady = resolve;
    });
    const nextReadyEntered = new Promise<void>((resolve) => {
      markNextReadyEntered = resolve;
    });
    waitForHostReady.mockImplementation(async () => {
      markNextReadyEntered();
      await nextReadyGate;
      return {
        ready: true,
        version: "9.9.9",
        pid: 778,
        reason: "ready",
      };
    });
    const next = ensure({ operationId: "op-next" });
    await nextReadyEntered;
    expect(currentEnvelope.status).toMatchObject({
      kind: "ensure",
      operationId: "op-next",
    });
    const lateJoin = ensure({ observedOperationId: "op-active" });
    releaseNextReady();
    await expect(lateJoin).resolves.toEqual({
      action: "superseded",
      running: false,
      version: null,
    });
    await expect(next).resolves.toEqual({
      action: "already-ready",
      running: true,
      version: "9.9.9",
    });
  });

  it("does not retain a busy verdict when the surfaced pid changed before retention", async () => {
    const replacementSnapshot: FakeHostSnapshot = {
      pid: SERVICE_PID + 1,
      hostId: "host-2",
      websocketUrl: SERVICE_LISTEN_URL,
      version: SERVICE_VERSION,
    };
    canReachHostWebsocketUrl.mockResolvedValue(false);
    hostManagesHostLoginItem.mockResolvedValue(false);
    streamCliWithinReservedOperation.mockRejectedValue(
      new Error("host is busy"),
    );
    categorizeHostCliError.mockReturnValue({
      kind: "host-busy",
      message: "host is busy",
      code: "E_HOST_BUSY",
    });
    const getServiceStatus = vi.fn(() => Promise.resolve(runningStatus));
    const reloadSnapshotFromDisk = vi.fn(() =>
      Promise.resolve(replacementSnapshot),
    );
    const getSnapshot = vi.fn(() => replacementSnapshot);
    const bridge = makeBridge(
      getServiceStatus,
      reloadSnapshotFromDisk,
      getSnapshot,
    );
    const ensure = registerEnsure(bridge);

    await expect(ensure({ operationId: "op-busy-pid-swap" })).rejects.toThrow(
      "host is busy",
    );
    expect(currentEnvelope.lastEnsureOutcome).toMatchObject({
      operationId: "op-busy-pid-swap",
      error: { message: "host is busy", code: "E_HOST_BUSY" },
    });
  });

  it("busy host-busy retention revalidates pid; pid loss/change before join is superseded", async () => {
    const busySnapshot: FakeHostSnapshot = {
      pid: SERVICE_PID,
      hostId: "host-1",
      websocketUrl: SERVICE_LISTEN_URL,
      version: SERVICE_VERSION,
    };
    canReachHostWebsocketUrl.mockResolvedValue(false);
    hostManagesHostLoginItem.mockResolvedValue(false);
    streamCliWithinReservedOperation.mockRejectedValue(
      new Error("host is busy"),
    );
    categorizeHostCliError.mockReturnValue({
      kind: "host-busy",
      message: "host is busy",
      code: "E_HOST_BUSY",
    });
    const getServiceStatus = vi.fn(() => Promise.resolve(runningStatus));
    const reloadSnapshotFromDisk = vi.fn(() => Promise.resolve(busySnapshot));
    const getSnapshot: Mock<() => FakeHostSnapshot | null> = vi.fn(
      () => busySnapshot,
    );
    const bridge = makeBridge(
      getServiceStatus,
      reloadSnapshotFromDisk,
      getSnapshot,
    );
    const ensure = registerEnsure(bridge);

    await expect(ensure({ operationId: "op-busy" })).resolves.toEqual({
      action: "host-busy",
      running: true,
      version: SERVICE_VERSION,
    });
    expect(currentEnvelope.lastEnsureOutcome).toMatchObject({
      operationId: "op-busy",
      result: { action: "host-busy" },
      busyHostPid: SERVICE_PID,
    });

    await expect(ensure({ observedOperationId: "op-busy" })).resolves.toEqual({
      action: "host-busy",
      running: true,
      version: SERVICE_VERSION,
    });

    getSnapshot.mockReturnValue({ ...busySnapshot, pid: SERVICE_PID + 1 });
    await expect(ensure({ observedOperationId: "op-busy" })).resolves.toEqual({
      action: "superseded",
      running: false,
      version: null,
    });

    getSnapshot.mockReturnValue(null);
    await expect(ensure({ observedOperationId: "op-busy" })).resolves.toEqual({
      action: "superseded",
      running: false,
      version: null,
    });
  });

  it("envelope revisions are monotonic across active transitions and settle-to-null", async () => {
    hasPendingLoginItemRevision.mockResolvedValue(true);
    probeHostActivityBusy.mockResolvedValue(false);
    registerHostLoginItem.mockResolvedValue("enabled");
    const { bridge, ensure } = makeRunningBridge(null);
    await ensure({ operationId: "op-rev" });
    const revisions = bridge.fanOut.mock.calls
      .map(([, payload]) => payload as HostOperationStatusEnvelope)
      .map((envelope) => envelope.revision);
    expect(revisions.length).toBeGreaterThan(1);
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]!);
    }
    // Settled envelope: status cleared, outcome revision matches envelope.
    expect(currentEnvelope.status).toBeNull();
    expect(currentEnvelope.lastEnsureOutcome?.revision).toBe(
      currentEnvelope.revision,
    );
  });
});
