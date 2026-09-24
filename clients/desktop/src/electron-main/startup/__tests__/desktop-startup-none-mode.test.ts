import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcHostController } from "../../ipc/runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  ConvergeReadyVersionPolicy,
  HostControllerStatus,
  LocalHostMutationIntent,
  MutationOutcome,
} from "../../host/host-controller-types";
import type { HostRegistryUpdateState } from "../../../ipc-contracts/host-management-types";
import type { LocalHostCapability } from "../../../ipc-contracts/host-lifecycle-types";
import type { SignedInGate } from "../host-launch-converge";
import { FakeHostController } from "../../ipc/__tests__/fake-host-controller";

const electronMock = vi.hoisted(() => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    getName: vi.fn(() => "Traycer"),
    getVersion: vi.fn(() => "0.0.0"),
    on: vi.fn(),
  },
  nativeImage: {},
}));
vi.mock("electron", () => electronMock);
vi.mock("@sentry/electron/main", () => ({}));

vi.mock("../../app/logger", () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const isHostRemovedByUserMock = vi.fn<() => Promise<boolean>>(
  async () => false,
);
vi.mock("../../host/host-removal-state", () => ({
  isHostRemovedByUser: () => isHostRemovedByUserMock(),
}));

const refreshRegistryUpdateStateMock =
  vi.fn<
    (
      hostController: IpcHostController,
      opts: { readonly force: boolean; readonly maxAgeMs: number | null },
    ) => Promise<HostRegistryUpdateState>
  >();
vi.mock("../../ipc/host-management-ipc", () => ({
  refreshRegistryUpdateState: (
    hostController: IpcHostController,
    opts: { readonly force: boolean; readonly maxAgeMs: number | null },
  ) => refreshRegistryUpdateStateMock(hostController, opts),
}));

// Imported after the mocks above so the module under test picks them up.
const { runDeferred } = await import("../desktop-startup");

function signedInGate(): SignedInGate {
  return {
    isSignedIn: () => true,
    onChanged: () => () => undefined,
  };
}

function fakeMenu() {
  return {
    setHostUpdateAvailableVersion: vi.fn<(version: string | null) => void>(),
  };
}

/** No runtime running (`unavailable`): the state that owes a boot converge. */
function noHostStatus(): HostControllerStatus {
  return {
    localAttempt: null,
    download: null,
    mutation: null,
    installedVersion: null,
    latestVersion: "1.4.1",
    stagedVersion: null,
    installedRuntimeVersion: null,
    runningRuntimeVersion: null,
    updateReady: false,
    activation: "unavailable",
    reachable: false,
    removedByUser: false,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeRegistryState(): HostRegistryUpdateState {
  return {
    checkedAt: "2026-01-01T00:00:00.000Z",
    latestVersion: "1.4.1",
    installedVersion: "1.4.1",
    updateAvailable: false,
    reachable: true,
    errorMessage: null,
  };
}

/** Counts every lane entry point `runDeferred` could reach. */
class CountingController extends FakeHostController {
  getStatusCalls = 0;
  convergeReadyCalls = 0;
  applyStagedCalls = 0;
  activateInstalledCalls = 0;
  stageLatestCalls = 0;

  override async getStatus(): Promise<HostControllerStatus> {
    this.getStatusCalls += 1;
    return noHostStatus();
  }
  override async convergeReady(
    _force: boolean,
    _intent: LocalHostMutationIntent,
    _versionPolicy: ConvergeReadyVersionPolicy,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    this.convergeReadyCalls += 1;
    return { kind: "ok", value: { running: true, version: "1.4.0" } };
  }
  override async applyStaged(
    _trigger: ApplyStagedTrigger,
    _force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    this.applyStagedCalls += 1;
    return {
      kind: "ok",
      value: { appliedVersion: "1.4.1", runningActivated: true, applied: true },
    };
  }
  override async activateInstalled(
    _force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    this.activateInstalledCalls += 1;
    return { kind: "ok", value: { activated: true } };
  }
  override async stageLatest(): Promise<void> {
    this.stageLatestCalls += 1;
  }

  totalLaneCalls(): number {
    return (
      this.convergeReadyCalls +
      this.applyStagedCalls +
      this.activateInstalledCalls +
      this.stageLatestCalls
    );
  }
}

interface FakeState {
  readonly bridge: { readonly disposeFns: Array<() => void> } | null;
}

function launch(
  controller: CountingController,
  localHostCapability: LocalHostCapability,
): {
  readonly state: FakeState;
  readonly backgroundCalls: () => number;
} {
  const state: FakeState = { bridge: { disposeFns: [] } };
  let backgroundCalls = 0;
  runDeferred(
    state,
    {
      hostController: controller,
      menu: fakeMenu(),
      signedIn: signedInGate(),
      localHostCapability,
    },
    () => {
      backgroundCalls += 1;
    },
  );
  return { state, backgroundCalls: () => backgroundCalls };
}

/** A real macrotask turn, so async actors get to run (or provably do not). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  refreshRegistryUpdateStateMock.mockResolvedValue(fakeRegistryState());
});

afterEach(() => {
  vi.clearAllMocks();
  isHostRemovedByUserMock.mockResolvedValue(false);
});

describe("runDeferred launch converge by local-host capability", () => {
  it("managed: the launch converge runs (control)", async () => {
    const controller = new CountingController();
    const { state, backgroundCalls } = launch(controller, "managed");

    await vi.waitFor(() => {
      expect(controller.convergeReadyCalls).toBeGreaterThanOrEqual(1);
    });
    expect(backgroundCalls()).toBe(1);
    expect(controller.getStatusCalls).toBeGreaterThan(0);
    // The boot actor registered its teardown on the bridge.
    expect(state.bridge?.disposeFns.length).toBeGreaterThan(0);
  });

  it("none: no converge, apply, activate or stage ever runs, but the background runner still does", async () => {
    const controller = new CountingController();
    const { state, backgroundCalls } = launch(controller, "none");

    await settle();

    expect(backgroundCalls()).toBe(1);
    expect(controller.convergeReadyCalls).toBe(0);
    expect(controller.applyStagedCalls).toBe(0);
    expect(controller.activateInstalledCalls).toBe(0);
    expect(controller.stageLatestCalls).toBe(0);
    expect(controller.getStatusCalls).toBe(0);
    expect(controller.totalLaneCalls()).toBe(0);
    // No boot actor was armed, so no teardown was registered.
    expect(state.bridge?.disposeFns).toHaveLength(0);
  });
});
