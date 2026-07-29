import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcHostController } from "../../ipc/runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  HostControllerStatus,
  MutationOutcome,
} from "../../host/host-controller-types";
import type { HostRegistryUpdateState } from "../../../ipc-contracts/host-management-types";
import type { DesktopStartupTestHooks } from "../desktop-startup";

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
const {
  runLaunchHostConvergeReconcile,
  refreshHostRegistryIfNotRemoved,
  applyHostUpdateMenuState,
} = await import("../host-launch-converge");
const { __setDesktopStartupTestHooks, runDesktopStartup } =
  await import("../desktop-startup");

function fakeMenu() {
  return {
    setHostUpdateAvailableVersion: vi.fn<(version: string | null) => void>(),
  };
}

function fakeStatus(
  updateReady: boolean,
  activation: HostControllerStatus["activation"],
  removedByUser: boolean,
): HostControllerStatus {
  return {
    download: null,
    mutation: null,
    installedVersion: "1.4.0",
    latestVersion: "1.4.1",
    stagedVersion: updateReady ? "1.4.1" : null,
    installedRuntimeVersion: null,
    runningRuntimeVersion: null,
    updateReady,
    activation,
    reachable: true,
    removedByUser,
    checkedAt: new Date().toISOString(),
  };
}

function fakeRegistryState(): HostRegistryUpdateState {
  return {
    checkedAt: new Date().toISOString(),
    latestVersion: "1.4.1",
    installedVersion: "1.4.1",
    updateAvailable: false,
    reachable: true,
    errorMessage: null,
  };
}

// Implements every `IpcHostController` method a caller could reach, throwing
// on anything not `not used by these tests` for the given scenario - the same
// fake pattern used in `registry-update-cache.test.ts`.
function fakeHostController(
  status: HostControllerStatus,
  applyStagedOutcome: MutationOutcome<ApplyStagedOk>,
  activateInstalledOutcome: MutationOutcome<ActivateInstalledOk>,
): IpcHostController & {
  readonly applyStagedCalls: readonly [ApplyStagedTrigger, boolean][];
  readonly activateInstalledCalls: readonly boolean[];
  readonly stageLatestCalls: number;
} {
  const applyStagedCalls: [ApplyStagedTrigger, boolean][] = [];
  const activateInstalledCalls: boolean[] = [];
  let stageLatestCalls = 0;
  return {
    get applyStagedCalls() {
      return applyStagedCalls;
    },
    get activateInstalledCalls() {
      return activateInstalledCalls;
    },
    get stageLatestCalls() {
      return stageLatestCalls;
    },
    async getStatus(): Promise<HostControllerStatus> {
      return status;
    },
    async applyStaged(
      trigger: ApplyStagedTrigger,
      force: boolean,
    ): Promise<MutationOutcome<ApplyStagedOk>> {
      applyStagedCalls.push([trigger, force]);
      return applyStagedOutcome;
    },
    async activateInstalled(
      force: boolean,
    ): Promise<MutationOutcome<ActivateInstalledOk>> {
      activateInstalledCalls.push(force);
      return activateInstalledOutcome;
    },
    convergeReady: () => {
      throw new Error(
        "fakeHostController.convergeReady: not used by these tests",
      );
    },
    async stageLatest(): Promise<void> {
      stageLatestCalls += 1;
    },
    installVersion: () => {
      throw new Error(
        "fakeHostController.installVersion: not used by these tests",
      );
    },
    registerService: () => {
      throw new Error(
        "fakeHostController.registerService: not used by these tests",
      );
    },
    deregisterService: () => {
      throw new Error(
        "fakeHostController.deregisterService: not used by these tests",
      );
    },
    respawn: () => {
      throw new Error("fakeHostController.respawn: not used by these tests");
    },
    recoverIfDown: () => {
      throw new Error(
        "fakeHostController.recoverIfDown: not used by these tests",
      );
    },
    freePortAndRestart: () => {
      throw new Error(
        "fakeHostController.freePortAndRestart: not used by these tests",
      );
    },
    uninstallHost: () => {
      throw new Error(
        "fakeHostController.uninstallHost: not used by these tests",
      );
    },
    removeTraycer: () => {
      throw new Error(
        "fakeHostController.removeTraycer: not used by these tests",
      );
    },
    isPendingRevisionRefreshQuarantined: () => {
      throw new Error(
        "fakeHostController.isPendingRevisionRefreshQuarantined: not used by these tests",
      );
    },
    onMutationProgress: () => {
      throw new Error(
        "fakeHostController.onMutationProgress: not used by these tests",
      );
    },
  };
}

describe("runLaunchHostConvergeReconcile (fixup B1 + B2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` only wipes call history, not implementations set via
    // `mockResolvedValue` - a test that opts into the removed-by-user branch
    // would otherwise leave that override in place for every test after it,
    // in this describe and the next.
    isHostRemovedByUserMock.mockResolvedValue(false);
  });

  it("B2: applies the stage instead of activating when a ready update is staged", async () => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    refreshRegistryUpdateStateMock.mockResolvedValue(fakeRegistryState());

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.applyStagedCalls).toEqual([["launch", false]]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  it("F7: stages a release before deciding launch convergence, then applies that same launch", async () => {
    const initial = fakeStatus(false, "activated", false);
    const staged = fakeStatus(true, "activated", false);
    const controller = fakeHostController(
      initial,
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    vi.spyOn(controller, "getStatus")
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(staged);
    refreshRegistryUpdateStateMock.mockResolvedValue(fakeRegistryState());

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.stageLatestCalls).toBe(1);
    expect(controller.applyStagedCalls).toEqual([["launch", false]]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  it("B2: activates pre-existing installed activation debt instead of applying when nothing is staged/ready", async () => {
    const controller = fakeHostController(
      fakeStatus(false, "pendingActivation", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.activateInstalledCalls).toEqual([false]);
    expect(controller.applyStagedCalls).toEqual([]);
    // The activate branch never moves `installedVersion` - no re-probe needed.
    expect(refreshRegistryUpdateStateMock).not.toHaveBeenCalled();
  });

  it("P1: leaves an already activated healthy host running on launch", async () => {
    const controller = fakeHostController(
      fakeStatus(false, "activated", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.applyStagedCalls).toEqual([]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  it("P1: does not resurrect a host removed by the user", async () => {
    const controller = fakeHostController(
      fakeStatus(false, "pendingActivation", true),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.applyStagedCalls).toEqual([]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  it("V2/P1: runDesktopStartup reaches deferred launch convergence, activating debt once and leaving the next launch running", async () => {
    const launchOneController = fakeHostController(
      fakeStatus(false, "pendingActivation", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const launchTwoController = fakeHostController(
      fakeStatus(false, "activated", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const background = vi.fn();
    const config = {
      environment: "production" as const,
      isDev: false,
      preloadPath: "/tmp/preload.js",
      iconPath: "/tmp/icon.png",
      authnBaseUrl: "https://auth.example.test",
    };
    const hooks = (
      hostController: IpcHostController,
    ): DesktopStartupTestHooks => ({
      config,
      runPreReady: () => undefined,
      whenReady: async () => undefined,
      runOnReady: async () => undefined,
      runWindowPhase: async () => ({ hostController, menu: fakeMenu() }),
      runDeferredBackground: background,
    });

    try {
      __setDesktopStartupTestHooks(hooks(launchOneController));
      await runDesktopStartup();
      await vi.waitFor(() => {
        expect(background).toHaveBeenCalledOnce();
        expect(launchOneController.applyStagedCalls).toEqual([]);
        expect(launchOneController.activateInstalledCalls).toEqual([false]);
      });

      __setDesktopStartupTestHooks(hooks(launchTwoController));
      await runDesktopStartup();
      await vi.waitFor(() => {
        expect(background).toHaveBeenCalledTimes(2);
        expect(launchTwoController.applyStagedCalls).toEqual([]);
        expect(launchTwoController.activateInstalledCalls).toEqual([]);
      });
    } finally {
      __setDesktopStartupTestHooks(null);
    }
  });

  it("B1: force-refreshes the registry and updates the menu after a successful apply", async () => {
    const readyStatus = fakeStatus(true, "unavailable", false);
    const convergedStatus = fakeStatus(false, "activated", false);
    const controller = fakeHostController(
      readyStatus,
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    // `runLaunchHostConvergeReconcile` reads status twice before deciding to
    // apply (initial removed-by-user check, then the post-stageLatest
    // decision read) - both must still show `updateReady` for the apply
    // branch to run at all. The third read (inside
    // `refreshHostRegistryIfNotRemoved`, after the apply committed) is what
    // this test is actually exercising.
    vi.spyOn(controller, "getStatus")
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValue(convergedStatus);
    refreshRegistryUpdateStateMock.mockResolvedValue(fakeRegistryState());
    const menu = fakeMenu();

    await runLaunchHostConvergeReconcile(controller, menu);

    expect(refreshRegistryUpdateStateMock).toHaveBeenCalledWith(controller, {
      force: true,
      maxAgeMs: null,
    });
    // The stage was consumed by the apply and the record is now activated -
    // menu cleared, not left advertising the update that was just applied.
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith(null);
  });

  it("B1: does not force-refresh when the apply outcome is not ok (busy/failed/deferred)", async () => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      { kind: "busy", continuation: "retry-with-force", message: "busy" },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(refreshRegistryUpdateStateMock).not.toHaveBeenCalled();
  });

  it("B1: skips the post-apply refresh when the host was removed by the user mid-apply", async () => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    isHostRemovedByUserMock.mockResolvedValue(true);

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(refreshRegistryUpdateStateMock).not.toHaveBeenCalled();
  });
});

describe("applyHostUpdateMenuState", () => {
  it("sets the staged version when a ready update is available", () => {
    const menu = fakeMenu();
    applyHostUpdateMenuState(menu, fakeStatus(true, "unavailable", false));
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith("1.4.1");
  });

  it("sets the installed version for pendingActivation debt (no ready update)", () => {
    const menu = fakeMenu();
    applyHostUpdateMenuState(
      menu,
      fakeStatus(false, "pendingActivation", false),
    );
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith("1.4.0");
  });

  it("sets the installed version for activationUnknown debt (no ready update)", () => {
    const menu = fakeMenu();
    applyHostUpdateMenuState(
      menu,
      fakeStatus(false, "activationUnknown", false),
    );
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith("1.4.0");
  });

  it("a ready update supersedes activation debt", () => {
    // updateReady + pendingActivation both true is the coexistence case the
    // reconcile explicitly prioritizes - the menu must show the ready
    // update's version, not the installed one.
    const menu = fakeMenu();
    applyHostUpdateMenuState(
      menu,
      fakeStatus(true, "pendingActivation", false),
    );
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith("1.4.1");
  });

  it("clears the menu state when up to date with no activation debt", () => {
    const menu = fakeMenu();
    applyHostUpdateMenuState(menu, fakeStatus(false, "activated", false));
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith(null);
  });

  it("never renders debt UI for activation:unavailable", () => {
    const menu = fakeMenu();
    applyHostUpdateMenuState(menu, fakeStatus(false, "unavailable", false));
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith(null);
  });
});

describe("refreshHostRegistryIfNotRemoved", () => {
  afterEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` only wipes call history, not implementations set via
    // `mockResolvedValue` - a test that opts into the removed-by-user branch
    // would otherwise leave that override in place for every test after it,
    // in this describe and the next.
    isHostRemovedByUserMock.mockResolvedValue(false);
  });

  it("skips the refresh entirely when the host was removed by the user", async () => {
    isHostRemovedByUserMock.mockResolvedValue(true);
    const controller = fakeHostController(
      fakeStatus(false, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const menu = fakeMenu();

    await refreshHostRegistryIfNotRemoved(controller, menu, {
      force: true,
      maxAgeMs: null,
    });

    expect(refreshRegistryUpdateStateMock).not.toHaveBeenCalled();
    expect(menu.setHostUpdateAvailableVersion).not.toHaveBeenCalled();
  });

  it("re-derives the menu label from a fresh status read after refreshing", async () => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    refreshRegistryUpdateStateMock.mockResolvedValue(fakeRegistryState());
    const menu = fakeMenu();

    await refreshHostRegistryIfNotRemoved(controller, menu, {
      force: true,
      maxAgeMs: null,
    });

    expect(refreshRegistryUpdateStateMock).toHaveBeenCalledWith(controller, {
      force: true,
      maxAgeMs: null,
    });
    expect(menu.setHostUpdateAvailableVersion).toHaveBeenCalledWith("1.4.1");
  });
});
