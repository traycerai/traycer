import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcHostController } from "../../ipc/runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
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
  readonly convergeReadyCalls: readonly boolean[];
  readonly stageLatestCalls: number;
  /**
   * Method names in invocation order. Counts alone cannot express "recovery
   * ran BEFORE the release download", which is the whole point of the
   * unavailable-first ordering.
   */
  readonly callOrder: readonly string[];
} {
  const applyStagedCalls: [ApplyStagedTrigger, boolean][] = [];
  const activateInstalledCalls: boolean[] = [];
  const convergeReadyCalls: boolean[] = [];
  const callOrder: string[] = [];
  let stageLatestCalls = 0;
  return {
    get callOrder() {
      return callOrder;
    },
    get applyStagedCalls() {
      return applyStagedCalls;
    },
    get activateInstalledCalls() {
      return activateInstalledCalls;
    },
    get convergeReadyCalls() {
      return convergeReadyCalls;
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
    async convergeReady(
      force: boolean,
    ): Promise<MutationOutcome<ConvergeReadyOk>> {
      convergeReadyCalls.push(force);
      callOrder.push("convergeReady");
      return { kind: "ok", value: { running: true, version: "1.4.0" } };
    },
    async stageLatest(): Promise<void> {
      stageLatestCalls += 1;
      callOrder.push("stageLatest");
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
    expect(controller.convergeReadyCalls).toEqual([]);
  });

  it("re-registers and starts an installed host when reinstall left its service unavailable", async () => {
    const controller = fakeHostController(
      fakeStatus(false, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.convergeReadyCalls).toEqual([false]);
    expect(controller.applyStagedCalls).toEqual([]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  // An unavailable service is not registered at all, so the host is
  // unreachable until it is. `stageLatest()` joins a controller-owned release
  // download that can run for minutes on a slow link; recovering after it
  // would leave the user hostless for that entire window.
  it("recovers an unavailable service BEFORE joining the release download", async () => {
    const controller = fakeHostController(
      fakeStatus(false, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.callOrder).toEqual(["convergeReady", "stageLatest"]);
    // Exactly once: the post-stage arm must not re-run a recovery that the
    // pre-stage pass already performed.
    expect(controller.convergeReadyCalls).toEqual([false]);
  });

  // Applying is itself the fastest route back to a running host and
  // re-registers on the way, so a ready stage keeps its precedence rather
  // than paying for a separate recovery first.
  // `activation: "unavailable"` describes the RUNNING runtime, so a machine
  // that has never installed a host reports it too. Recovering there would
  // provision and start a background host before sign-in, bypassing the
  // renderer's signed-in provisioning gate.
  it("does not provision a host that was never installed", async () => {
    const controller = fakeHostController(
      { ...fakeStatus(false, "unavailable", false), installedVersion: null },
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.convergeReadyCalls).toEqual([]);
    expect(controller.applyStagedCalls).toEqual([]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  it("keeps apply-first precedence when an update is already staged", async () => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.convergeReadyCalls).toEqual([]);
    expect(controller.applyStagedCalls).toEqual([["launch", false]]);
  });

  // The other side of that precedence. `applyStaged` RESOLVES its failures
  // rather than throwing, and the pre-stage recovery stood down because a
  // stage was ready - so when the apply then does not land, an absent service
  // had nobody left to re-register it and the machine stayed unreachable until
  // the next launch.
  it.each([
    ["a failed apply", { kind: "failed" as const, message: "apply failed" }],
    [
      "a stage that no longer matches",
      { kind: "stage-fingerprint-mismatch" as const, message: "mismatch" },
    ],
    [
      "bytes that committed without converging",
      { kind: "installed-not-converged" as const, message: "not converged" },
    ],
    // Codex P1: `deferred` is NOT always contention. A registry outage leaves
    // the stage un-eligibility-checked and resolves this same arm while
    // holding no lock at all - skipping recovery there left an installed
    // service unregistered because a network probe failed. The lock-contention
    // reading is safe here too: convergeReady runs its own bounded CLI-lock
    // retry and resolves deferred itself.
    [
      "an apply deferred by an unreachable registry",
      {
        kind: "deferred" as const,
        message: "The staged host could not be eligibility-checked.",
      },
    ],
  ])("recovers an absent service after %s", async (_label, outcome) => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      outcome,
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.applyStagedCalls).toEqual([["launch", false]]);
    expect(controller.convergeReadyCalls).toEqual([false]);
  });

  // `busy` is the one pass-through: the controller's own gate says the host
  // has work in progress, and convergeReady consults the same gate. Note the
  // asymmetry with `deferred` above - that arm carries a non-contention
  // meaning (registry outage) and so must go through the status gates.
  it("does not chase a busy apply with a recovery", async () => {
    const controller = fakeHostController(
      fakeStatus(true, "unavailable", false),
      {
        kind: "busy",
        continuation: "retry-with-force",
        message: "busy",
      },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.applyStagedCalls).toEqual([["launch", false]]);
    expect(controller.convergeReadyCalls).toEqual([]);
  });

  it("does not recover after a failed apply when the service is present anyway", async () => {
    // A failed apply is not by itself an activation problem. Without this the
    // arm would fire on every unsuccessful update, turning an ordinary "stayed
    // on the old version" into a service cycle.
    const controller = fakeHostController(
      fakeStatus(true, "activated", false),
      { kind: "failed", message: "apply failed" },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.convergeReadyCalls).toEqual([]);
  });

  it("does not turn a failed apply into a first install on a host that was never installed", async () => {
    const controller = fakeHostController(
      { ...fakeStatus(true, "unavailable", false), installedVersion: null },
      { kind: "failed", message: "apply failed" },
      { kind: "ok", value: { activated: true } },
    );

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.convergeReadyCalls).toEqual([]);
  });

  it("does not recover when the user removed the host during the apply", async () => {
    // The apply can take minutes. `removedByUser` is therefore re-read after
    // it rather than inherited from the pre-apply sample - a user who removed
    // the host mid-update must not be handed a reinstall.
    const base = fakeHostController(
      fakeStatus(true, "unavailable", false),
      { kind: "failed", message: "apply failed" },
      { kind: "ok", value: { activated: true } },
    );
    let statusReads = 0;
    const controller: IpcHostController & {
      readonly convergeReadyCalls: readonly boolean[];
    } = {
      ...base,
      // Reads 1 and 2 are the initial and post-stage samples; the third is the
      // one this arm takes after the apply returns.
      async getStatus(): Promise<HostControllerStatus> {
        statusReads += 1;
        return fakeStatus(true, "unavailable", statusReads > 2);
      },
    };

    await runLaunchHostConvergeReconcile(controller, fakeMenu());

    expect(controller.convergeReadyCalls).toEqual([]);
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
