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
import type { SignedInGate } from "../host-launch-converge";

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
  armFirstInstallOnSignIn,
  refreshHostRegistryIfNotRemoved,
  applyHostUpdateMenuState,
} = await import("../host-launch-converge");
const { __setDesktopStartupTestHooks, runDesktopStartup } =
  await import("../desktop-startup");

/**
 * A {@link SignedInGate} whose answer can flip, so a test can drive the
 * sign-in TRANSITION rather than only the already-signed-in case - the
 * transition is the arm that reproduces the pre-retirement timing, where the
 * host was installed once the gate mounted after sign-in.
 */
function fakeSignedInGate(initial: boolean): SignedInGate & {
  signIn(): void;
  signOut(): void;
  listenerCount(): number;
} {
  let signedIn = initial;
  const listeners = new Set<(next: boolean) => void>();
  return {
    isSignedIn: () => signedIn,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signIn: () => {
      signedIn = true;
      for (const listener of Array.from(listeners)) listener(true);
    },
    // Notifies exactly like `signIn`, because the production gate does: the
    // arm's handler is what ignores the falling edge, and a fake that stayed
    // silent would hide whether that is safe.
    signOut: () => {
      signedIn = false;
      for (const listener of Array.from(listeners)) listener(false);
    },
    listenerCount: () => listeners.size,
  };
}

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
   * How many times status was sampled. Lets a test wait for an actor that
   * DECLINES to act - "no converge" is not observable until you know the
   * decision was actually reached, rather than still pending.
   */
  readonly getStatusCalls: number;
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
  let getStatusCalls = 0;
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
    get getStatusCalls() {
      return getStatusCalls;
    },
    async getStatus(): Promise<HostControllerStatus> {
      getStatusCalls += 1;
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
      // SIGNED OUT for this composition test, so the first-install actor
      // provably cannot contribute to the assertions below: it arms, sees no
      // signed-in identity, and waits. What is under test here is activation
      // debt on a host that already exists.
      runWindowPhase: async () => ({
        hostController,
        menu: fakeMenu(),
        signedIn: fakeSignedInGate(false),
      }),
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

describe("armFirstInstallOnSignIn", () => {
  const neverInstalled = (removedByUser: boolean): HostControllerStatus => ({
    ...fakeStatus(false, "unavailable", removedByUser),
    installedVersion: null,
  });

  it("re-arms after an attempt that THREW, instead of retiring the only first-install actor", async () => {
    // `settled` used to be set before the async work started, and the detached
    // promise had no catch: one transient IPC failure retired first-install for
    // the whole process, leaving a signed-in user in the unavailable-host flow
    // until a manual retry or a relaunch.
    const controller = fakeHostController(
      neverInstalled(false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    let statusCalls = 0;
    const throwsFirstTime: IpcHostController = {
      ...controller,
      getStatus: () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return Promise.reject(new Error("host ipc unavailable"));
        }
        return controller.getStatus();
      },
    };
    const gate = fakeSignedInGate(true);

    armFirstInstallOnSignIn(throwsFirstTime, gate);

    await vi.waitFor(() => {
      expect(statusCalls).toBe(1);
    });
    expect(controller.convergeReadyCalls).toEqual([]);
    // The subscription is what the failure re-arms against, so it must still
    // be there - the immediate-attempt path used to skip subscribing entirely.
    expect(gate.listenerCount()).toBe(1);

    gate.signIn();

    await vi.waitFor(() => {
      expect(controller.convergeReadyCalls).toEqual([false]);
    });
    // And the retry that succeeded settles it: no third attempt.
    expect(gate.listenerCount()).toBe(0);
  });

  it("stays armed after a RESOLVED non-ok outcome, and retries on the next sign-in edge", async () => {
    // Deliberately NOT a throw. The throw path was fixed in `2e05de85` and its
    // test sits directly above; this is the surviving half - `busy`,
    // `deferred` and `failed` are ordinary resolved values, so they never
    // reach the catch, and `outcome.kind` was logged without being read.
    //
    // `convergeReady` is OVERRIDDEN rather than configured, because
    // `fakeHostController` hardcodes it to `ok` - its second parameter is
    // `applyStagedOutcome`, not the converge outcome. Passing a `failed`
    // there drives the SUCCESS path while looking like a failure fixture, and
    // an earlier version of this test did exactly that and passed for the
    // wrong reason.
    const base = fakeHostController(
      neverInstalled(false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const convergeCalls: boolean[] = [];
    let outcomeKind: MutationOutcome<ConvergeReadyOk>["kind"] = "failed";
    const failsConverge: IpcHostController = {
      ...base,
      convergeReady: (force: boolean) => {
        convergeCalls.push(force);
        return Promise.resolve(
          outcomeKind === "ok"
            ? {
                kind: "ok" as const,
                value: { running: true, version: "1.4.0" },
              }
            : {
                kind: "failed" as const,
                message: "installer could not write to the prefix",
              },
        );
      },
    };
    const gate = fakeSignedInGate(true);

    armFirstInstallOnSignIn(failsConverge, gate);

    await vi.waitFor(() => {
      expect(convergeCalls).toEqual([false]);
    });

    // Premise, positively: the convergence really ran and really came back
    // non-ok, and nothing is installed. Without this the assertions below are
    // satisfied by an arm that never attempted anything.
    expect(outcomeKind).toBe("failed");
    expect(await failsConverge.getStatus()).toMatchObject({
      installedVersion: null,
    });

    // Fixed: the arm survives, so the sign-in edge it retries from is still
    // subscribed...
    expect(gate.listenerCount()).toBe(1);

    // ...and that edge produces a REAL second attempt which, this time
    // succeeding, settles the arm. Asserting only the listener count would
    // pass on a build that kept the subscription and never acted on it - the
    // point is the retry, not the bookkeeping.
    outcomeKind = "ok";
    gate.signIn();
    await vi.waitFor(() => {
      expect(convergeCalls).toEqual([false, false]);
    });
    await vi.waitFor(() => {
      expect(gate.listenerCount()).toBe(0);
    });
  });

  it("installs once for a signed-in user on a machine that has never had a host", async () => {
    const controller = fakeHostController(
      neverInstalled(false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    armFirstInstallOnSignIn(controller, fakeSignedInGate(true));

    await vi.waitFor(() => {
      expect(controller.convergeReadyCalls).toEqual([false]);
    });
    // The reconciler's arms are not this actor's business, and vice versa.
    expect(controller.applyStagedCalls).toEqual([]);
    expect(controller.activateInstalledCalls).toEqual([]);
  });

  it("CONSENT: a signed-out launch installs nothing, and waits rather than giving up", async () => {
    const controller = fakeHostController(
      neverInstalled(false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const gate = fakeSignedInGate(false);

    armFirstInstallOnSignIn(controller, gate);
    await Promise.resolve();

    // Installing a background service is consent-bearing: the retired renderer
    // path only ever provisioned for a signed-in user, and restoring it
    // unconditionally would be the same action under a weaker precondition.
    expect(controller.convergeReadyCalls).toEqual([]);
    // ...and it is WAITING, not declining. A test that only asserted the empty
    // call list would pass just as happily against an actor that gave up.
    expect(gate.listenerCount()).toBe(1);
  });

  it("installs on the sign-in TRANSITION - the pre-retirement timing", async () => {
    const controller = fakeHostController(
      neverInstalled(false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const gate = fakeSignedInGate(false);
    armFirstInstallOnSignIn(controller, gate);

    gate.signIn();

    await vi.waitFor(() => {
      expect(controller.convergeReadyCalls).toEqual([false]);
    });
    // One-shot: the subscription is released once it has acted.
    expect(gate.listenerCount()).toBe(0);
  });

  it("CONSENT: a sign-out landing inside the status round trip installs nothing", async () => {
    // The window is real and not narrow in wall-clock terms: `getStatus()` is
    // an IPC round trip to the host controller, and the arm's decision to act
    // was taken BEFORE it. The falling edge reaches the subscription while
    // that promise is pending and is ignored there by design (the handler only
    // acts on `signedIn`), so nothing between the decision and the install
    // re-reads consent unless this arm does.
    const base = fakeHostController(
      neverInstalled(false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );
    const gate = fakeSignedInGate(true);
    const convergeCalls: boolean[] = [];
    let statusCalls = 0;
    // The sign-out is delivered FROM INSIDE the status read, which is what
    // makes this deterministic rather than a race the scheduler might win: the
    // continuation cannot run before its own await resolves.
    const signsOutMidStatus: IpcHostController = {
      ...base,
      getStatus: () => {
        statusCalls += 1;
        if (statusCalls === 1) gate.signOut();
        return Promise.resolve(neverInstalled(false));
      },
      convergeReady: (force: boolean) => {
        convergeCalls.push(force);
        return Promise.resolve({
          kind: "ok" as const,
          value: { running: true, version: "1.4.0" },
        });
      },
    };

    armFirstInstallOnSignIn(signsOutMidStatus, gate);

    await vi.waitFor(() => {
      expect(statusCalls).toBe(1);
    });
    // Premise, positively: the attempt really did start under a signed-in
    // gate and really did reach the status read. Without this the assertion
    // below is satisfied by an arm that never attempted anything at all.
    expect(gate.isSignedIn()).toBe(false);
    expect(convergeCalls).toEqual([]);

    // WAITING, not declining - the same shape as a signed-out launch. An
    // assertion on the empty call list alone would pass against an arm that
    // gave up and left the machine hostless for the session.
    expect(gate.listenerCount()).toBe(1);

    // And the wait is live: a real sign-in still installs. This is the arm
    // that fails if the re-read were implemented by settling instead of
    // returning.
    gate.signIn();
    await vi.waitFor(() => {
      expect(convergeCalls).toEqual([false]);
    });
    await vi.waitFor(() => {
      expect(gate.listenerCount()).toBe(0);
    });
  });

  it("CONSENT: a host the user removed is never reinstalled, even signed in", async () => {
    const controller = fakeHostController(
      neverInstalled(true),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    armFirstInstallOnSignIn(controller, fakeSignedInGate(true));
    await vi.waitFor(() => {
      expect(controller.getStatusCalls).toBeGreaterThan(0);
    });

    // `installedVersion` is null for a REMOVED host too, so the sentinel is
    // the only thing separating "never had one" from "deliberately got rid of
    // it" - and it is checked at the moment of acting, not at arming.
    expect(controller.convergeReadyCalls).toEqual([]);
  });

  it("does nothing when a host is already installed - that debt is the reconciler's", async () => {
    const controller = fakeHostController(
      fakeStatus(false, "activated", false),
      {
        kind: "ok",
        value: { appliedVersion: "1.4.1", runningActivated: true },
      },
      { kind: "ok", value: { activated: true } },
    );

    armFirstInstallOnSignIn(controller, fakeSignedInGate(true));
    await vi.waitFor(() => {
      expect(controller.getStatusCalls).toBeGreaterThan(0);
    });

    expect(controller.convergeReadyCalls).toEqual([]);
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
