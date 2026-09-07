import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import type {
  ConvergeReadyOk,
  HostControllerStatus,
  IHostManagement,
  LocalHostSnapshot,
  MutationOutcome,
  MutationProgress,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostProvisioningController,
  LOCAL_HOST_SLOW_START_THRESHOLD_MS,
  type HostProvisioningLifecycle,
} from "@/components/host/host-provisioning-controller";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";

const validSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
  availability: "available",
};

function makeHost(snapshot: LocalHostSnapshot | null): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: snapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

const IDLE_CONTROLLER_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: validSnapshot.version,
  latestVersion: validSnapshot.version,
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "activated",
  reachable: true,
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

function makeHostManagement(
  convergeReady: IHostManagement["convergeReady"],
): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} not implemented in this test`));
  return {
    getHostControllerStatus: () => Promise.resolve(IDLE_CONTROLLER_STATUS),
    convergeReady,
    applyStaged: notImplemented("applyStaged"),
    activateInstalled: notImplemented("activateInstalled"),
    installVersion: notImplemented("installVersion"),
    uninstallHost: notImplemented("uninstallHost"),
    restartHost: notImplemented("restartHost"),
    uninstallTraycer: notImplemented("uninstallTraycer"),
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
    clearRemoval: () => Promise.resolve(),
    getHostLogs: notImplemented("getHostLogs"),
    runDoctor: notImplemented("runDoctor"),
    availableVersions: notImplemented("availableVersions"),
    installedRecord: () => Promise.resolve(null),
    registerService: notImplemented("registerService"),
    deregisterService: notImplemented("deregisterService"),
    registryCheck: notImplemented("registryCheck"),
    freePortAndRestart: (input) => Promise.resolve(input),
    runDoctorRepairQueued: () => Promise.resolve({ kind: "applied" as const }),
    freePortAndRestartIfIdle: () =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    cliManifest: () => Promise.resolve(null),
    maintenanceUpdateCheck: notImplemented("maintenanceUpdateCheck"),
    maintenanceDoctor: notImplemented("maintenanceDoctor"),
    maintenanceInstallationInfo: notImplemented("maintenanceInstallationInfo"),
    maintenanceInstallVersion: notImplemented("maintenanceInstallVersion"),
    restartHostIfIdle: notImplemented("restartHostIfIdle"),
    runDoctorRepairIfIdle: notImplemented("runDoctorRepairIfIdle"),
    getHostName: () =>
      Promise.resolve({
        systemName: validSnapshot.systemHostName,
        customName: null,
        effectiveName: validSnapshot.displayName,
      }),
    setHostName: (input) =>
      Promise.resolve({
        systemName: validSnapshot.systemHostName,
        customName: input.customName,
        effectiveName: input.customName ?? validSnapshot.systemHostName,
      }),
  };
}

class DeferredInitialSnapshotHost extends MockRunnerHost {
  private readonly deferredHandlers = new Set<
    (snapshot: LocalHostSnapshot | null) => void
  >();
  private readonly deferredSnapshot: LocalHostSnapshot | null;

  constructor(snapshot: LocalHostSnapshot | null, management: IHostManagement) {
    super({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: snapshot,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    this.deferredSnapshot = snapshot;
  }

  override onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    this.deferredHandlers.add(handler);
    return {
      dispose: () => {
        this.deferredHandlers.delete(handler);
      },
    };
  }

  emitInitialSnapshot(): void {
    for (const handler of this.deferredHandlers) {
      handler(this.deferredSnapshot);
    }
  }
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function advancePastSlowStartThreshold(): void {
  act(() => {
    vi.advanceTimersByTime(LOCAL_HOST_SLOW_START_THRESHOLD_MS + 10);
  });
}

function mountProvisioningLifecycle(host: MockRunnerHost): {
  readonly queryClient: QueryClient;
  readonly readLifecycle: () => HostProvisioningLifecycle | null;
} {
  const queryClient = buildQueryClient();
  let latest: HostProvisioningLifecycle | null = null;
  function Probe(props: {
    readonly lifecycle: HostProvisioningLifecycle;
  }): ReactNode {
    const { lifecycle } = props;
    // Published from the commit phase, not during render (react-hooks/globals).
    useEffect(() => {
      latest = lifecycle;
    });
    return (
      <div
        data-testid="provisioning-lifecycle-probe"
        data-local-host-state={lifecycle.localHostState}
        data-slow-start-stage={lifecycle.slowStartStage}
        data-is-provisioning={String(lifecycle.provisioning.isProvisioning)}
        data-has-error={String(lifecycle.provisioning.error !== null)}
        data-progress-stage={lifecycle.provisioning.progress?.stage ?? ""}
        data-last-progress-stage={
          lifecycle.provisioning.lastProgress?.stage ?? ""
        }
      />
    );
  }
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostProvisioningController enabled isReady={false}>
          {(lifecycle) => <Probe lifecycle={lifecycle} />}
        </HostProvisioningController>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    queryClient,
    readLifecycle: () => latest,
  };
}

const runnerToastSpy = vi.fn<(error: unknown, fallback: string) => void>();
vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: (error: unknown, fallback: string): void => {
    runnerToastSpy(error, fallback);
  },
}));

describe("HostProvisioningController - staged wait and localHostState derivation", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("holds unavailable/loading on mount when the runner emits a null snapshot - no slow promotion yet", () => {
    vi.useFakeTimers();
    const { readLifecycle } = mountProvisioningLifecycle(makeHost(null));

    // `IRunnerHost.onLocalHostChange` is required to fire synchronously on subscribe, so by the time effects
    // settle the state has already moved past `unknown` (`state === null`) to the derived `unavailable`.
    expect(readLifecycle()?.localHostState).toBe("unavailable");
    expect(readLifecycle()?.slowStartStage).toBe("loading");
  });

  it("never provisions on mount - the authority owns boot intent; only a user gesture calls convergeReady", async () => {
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({
        kind: "ok",
        value: { running: true, version: "1.2.3" },
      }),
    );
    const host = new DeferredInitialSnapshotHost(
      null,
      makeHostManagement(convergeReady),
    );
    const { readLifecycle } = mountProvisioningLifecycle(host);

    expect(convergeReady).not.toHaveBeenCalled();
    // The subscribe effect never receives a synchronous callback from this
    // deferred host, so the state genuinely stays `unknown` here.
    expect(readLifecycle()?.localHostState).toBe("unknown");

    // The first local-host snapshot arriving used to be exactly what fired
    // the retired automatic ensure - it must now be a no-op for convergeReady.
    act(() => {
      host.emitInitialSnapshot();
    });
    await Promise.resolve();
    expect(convergeReady).not.toHaveBeenCalled();

    // The manual path - a user's Retry gesture - still works.
    act(() => {
      readLifecycle()?.provisioning.retry();
    });

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
    });
  });

  it("promotes slowStartStage to slow once the threshold elapses without a usable snapshot", () => {
    vi.useFakeTimers();
    const { readLifecycle } = mountProvisioningLifecycle(makeHost(null));

    expect(readLifecycle()?.slowStartStage).toBe("loading");

    advancePastSlowStartThreshold();

    expect(readLifecycle()?.slowStartStage).toBe("slow");
    expect(readLifecycle()?.localHostState).toBe("unavailable");
  });

  it("derives ready once a valid snapshot arrives, from an initially-null runner", async () => {
    const host = makeHost(null);
    const { readLifecycle } = mountProvisioningLifecycle(host);

    expect(readLifecycle()?.localHostState).toBe("unavailable");

    act(() => {
      host.setLocalHost(validSnapshot);
    });

    await waitFor(() => {
      expect(readLifecycle()?.localHostState).toBe("ready");
    });
  });

  it("derives ready immediately when the initial snapshot has both URLs", async () => {
    const { readLifecycle } = mountProvisioningLifecycle(
      makeHost(validSnapshot),
    );

    await waitFor(() => {
      expect(readLifecycle()?.localHostState).toBe("ready");
    });
  });

  it("derives unavailable for a snapshot with an empty websocketUrl, and still stages loading->slow", () => {
    vi.useFakeTimers();
    const partial: LocalHostSnapshot = { ...validSnapshot, websocketUrl: "" };
    const { readLifecycle } = mountProvisioningLifecycle(makeHost(partial));

    expect(readLifecycle()?.localHostState).toBe("unavailable");
    expect(readLifecycle()?.slowStartStage).toBe("loading");

    advancePastSlowStartThreshold();

    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("restarts the staged wait at loading on a Ready -> not-ready transition", () => {
    // The stage must be `slow` before the host comes up, or this proves nothing.
    vi.useFakeTimers();
    const host = makeHost(null);
    const { readLifecycle } = mountProvisioningLifecycle(host);

    advancePastSlowStartThreshold();
    expect(readLifecycle()?.slowStartStage).toBe("slow");

    act(() => {
      host.setLocalHost(validSnapshot);
    });
    expect(readLifecycle()?.localHostState).toBe("ready");

    act(() => {
      host.setLocalHost(null);
    });

    expect(readLifecycle()?.localHostState).toBe("unavailable");
    expect(readLifecycle()?.slowStartStage).toBe("loading");

    // And the restarted wait is a real one: it promotes again on its own.
    advancePastSlowStartThreshold();
    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("replays the current snapshot to a subscriber that mounts after the host already has a value", async () => {
    // The subscription must still see the current value synchronously so the lifecycle does not stall at
    // `unknown`.
    const host = makeHost(null);
    host.setLocalHost(validSnapshot);

    let subscribeCount = 0;
    const originalSubscribe = host.onLocalHostChange.bind(host);
    host.onLocalHostChange = (handler) => {
      subscribeCount += 1;
      return originalSubscribe(handler);
    };

    const { readLifecycle } = mountProvisioningLifecycle(host);

    await waitFor(() => {
      expect(readLifecycle()?.localHostState).toBe("ready");
    });
    expect(subscribeCount).toBeGreaterThanOrEqual(1);
  });
});

describe("HostProvisioningController - retry/force gestures and the busy-keep latch", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // What this component owns - and what a user's data depends on - is that the forced path asks for force, and
  // the ordinary Retry path does not.
  it("the forced-update gesture calls convergeReady with force=true; plain Retry does not", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({
        kind: "ok",
        value: { running: true, version: "1.2.4" },
      }),
    );
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: validSnapshot,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: makeHostManagement(convergeReady),
    });
    const { readLifecycle } = mountProvisioningLifecycle(host);

    // Settling it here is what makes the counts below describe the gestures rather than a race between two actors.
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
    });

    act(() => {
      readLifecycle()?.provisioning.force();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledWith(true);
    });
    expect(convergeReady).toHaveBeenCalledTimes(2);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(3);
    });
    expect(convergeReady).toHaveBeenLastCalledWith(false);
  });

  // The busy-keep latch: a "busy" convergeReady outcome must keep the caller off the still-unprobed busy host,
  // and that must survive both a plain Refresh and a forced update.
  it("a busy convergeReady latches busy-keep, and the latch survives both a plain Refresh and a forced update", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({
        kind: "busy",
        continuation: "retry-with-force",
        message: "The running host has work in progress.",
      }),
    );
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: validSnapshot,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: makeHostManagement(convergeReady),
    });
    const { readLifecycle } = mountProvisioningLifecycle(host);

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
    });

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(2);
      expect(readLifecycle()?.provisioning.hostBusy).toBe(true);
    });
    expect(convergeReady).toHaveBeenLastCalledWith(false);

    // Refresh: re-check the busy status without forcing. Latched - the point of `markBusyKeep` is that only a
    // success clears it, so a second busy answer must not read as recovery.
    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(3);
    });
    expect(convergeReady).toHaveBeenLastCalledWith(false);
    expect(readLifecycle()?.provisioning.hostBusy).toBe(true);

    act(() => {
      readLifecycle()?.provisioning.force();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(4);
    });
    expect(convergeReady).toHaveBeenLastCalledWith(true);
  });

  // The state restore below is not the feedback - the Reinstall button reappearing is indistinguishable from a
  // click that never registered, which is the whole defect.
  it("reinstall() says so when the sentinel could not be cleared, and restores removed", async () => {
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({ kind: "ok", value: { running: false, version: null } }),
    );
    const baseManagement = makeHostManagement(convergeReady);
    const failure = new Error("sentinel write denied");
    const clearRemoval = vi.fn(() => Promise.reject(failure));
    const management: IHostManagement = {
      ...baseManagement,
      clearRemoval,
    };
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.removed).toBe(true);
    });
    expect(convergeReady).toHaveBeenCalledTimes(1);

    act(() => {
      readLifecycle()?.provisioning.reinstall();
    });

    await waitFor(() => {
      expect(runnerToastSpy).toHaveBeenCalledTimes(1);
    });
    // The rejection reason reaches the shared handler, not a swallowed generic: a typed bridge error keeps its own
    // message there.
    expect(runnerToastSpy.mock.calls[0]?.[0]).toBe(failure);

    // And the surface is back where it was, so a retry is possible.
    expect(readLifecycle()?.provisioning.removed).toBe(true);
    expect(
      queryClient.getQueryData(runnerQueryKeys.hostRemovalState(management)),
    ).toEqual({ removedByUser: true });
    // Nothing ran: a failed clear must not fall through to a converge.
    expect(convergeReady).toHaveBeenCalledTimes(1);
  });
});

describe("HostProvisioningController - removed-by-user latch", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.restoreAllMocks();
  });

  // Kills: deleting `setRemoved(isRemovedOutcome)` in `markBusyKeep`, or the
  // removal-state cache mirror write beside it.
  it("a running:false convergeReady outcome latches removed and mirrors the removal-state cache; a running:true settle clears both", async () => {
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({ kind: "ok", value: { running: false, version: null } }),
    );
    const management = makeHostManagement(convergeReady);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
      expect(readLifecycle()?.provisioning.removed).toBe(true);
    });
    expect(
      queryClient.getQueryData(runnerQueryKeys.hostRemovalState(management)),
    ).toEqual({ removedByUser: true });

    // A later settle with running:true (e.g. after a successful reinstall) clears the latch and its cache mirror -
    // it must not survive an unrelated success the way the busy-keep latch's own settle would.
    convergeReady.mockImplementationOnce(() =>
      Promise.resolve({
        kind: "ok",
        value: { running: true, version: "1.2.3" },
      }),
    );
    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(2);
      expect(readLifecycle()?.provisioning.removed).toBe(false);
    });
    expect(
      queryClient.getQueryData(runnerQueryKeys.hostRemovalState(management)),
    ).toEqual({ removedByUser: false });
  });

  // Kills: dropping the optimistic `setRemoved(false)` / cache write in `reinstall`, or calling `run` before
  // `clearRemoval` resolves instead of after.
  it("reinstall() optimistically drops removed, then clears the sentinel and re-runs convergeReady with force:false", async () => {
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({ kind: "ok", value: { running: false, version: null } }),
    );
    const baseManagement = makeHostManagement(convergeReady);
    let resolveClearRemoval: () => void = () => {
      throw new Error("clearRemoval resolver was not initialized");
    };
    const clearRemovalPromise = new Promise<void>((resolve) => {
      resolveClearRemoval = resolve;
    });
    const clearRemoval = vi.fn(() => clearRemovalPromise);
    const management: IHostManagement = {
      ...baseManagement,
      clearRemoval,
    };
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    // Latch removed first, exactly as the previous test does.
    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.removed).toBe(true);
    });
    expect(convergeReady).toHaveBeenCalledTimes(1);

    act(() => {
      readLifecycle()?.provisioning.reinstall();
    });

    // Optimistic: dropped synchronously, before clearRemoval settles.
    expect(clearRemoval).toHaveBeenCalledTimes(1);
    expect(readLifecycle()?.provisioning.removed).toBe(false);
    expect(
      queryClient.getQueryData(runnerQueryKeys.hostRemovalState(management)),
    ).toEqual({ removedByUser: false });
    expect(convergeReady).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveClearRemoval();
      await clearRemovalPromise;
    });

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(2);
    });
    expect(convergeReady).toHaveBeenLastCalledWith(false);
  });

  // Kills: dropping the `clearRemoval` rejection handler in `reinstall`, or leaving `removed`/its cache mirror
  // on the optimistic `false` after a failed clear.
  it("a rejected clearRemoval() restores removed and its cache mirror instead of leaving a resolved spinner", async () => {
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({ kind: "ok", value: { running: false, version: null } }),
    );
    const baseManagement = makeHostManagement(convergeReady);
    const clearRemovalRejection = new Error("clearRemoval failed");
    const clearRemovalPromise = Promise.reject<void>(clearRemovalRejection);
    // Attach a no-op catch immediately so the still-pending assertion promise below is not the first handler and
    // vitest never reports this as an unhandled rejection while it is in flight.
    clearRemovalPromise.catch(() => undefined);
    const clearRemoval = vi.fn(() => clearRemovalPromise);
    const management: IHostManagement = {
      ...baseManagement,
      clearRemoval,
    };
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.removed).toBe(true);
    });

    await act(async () => {
      readLifecycle()?.provisioning.reinstall();
      await clearRemovalPromise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(readLifecycle()?.provisioning.removed).toBe(true);
    });
    expect(
      queryClient.getQueryData(runnerQueryKeys.hostRemovalState(management)),
    ).toEqual({ removedByUser: true });
    // The failed reinstall must never have re-run convergeReady - only the
    // initial latch call counts.
    expect(convergeReady).toHaveBeenCalledTimes(1);
  });
});

describe("HostProvisioningController - hostManagement gating", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.restoreAllMocks();
  });

  // Returns an accessor, like `mountProvisioningLifecycle` above, rather than the captured value.
  function mountLifecycleWithEnabled(
    host: MockRunnerHost,
    enabled: boolean,
  ): () => HostProvisioningLifecycle {
    const captured: { value: HostProvisioningLifecycle | null } = {
      value: null,
    };
    function Probe(props: {
      readonly lifecycle: HostProvisioningLifecycle;
    }): ReactNode {
      const { lifecycle } = props;
      useEffect(() => {
        captured.value = lifecycle;
      });
      return null;
    }
    render(
      <QueryClientProvider client={buildQueryClient()}>
        <RunnerHostProvider runnerHost={host}>
          <HostProvisioningController enabled={enabled} isReady={false}>
            {(lifecycle) => <Probe lifecycle={lifecycle} />}
          </HostProvisioningController>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    return () => {
      const value = captured.value;
      if (value === null) {
        throw new Error("lifecycle was not captured");
      }
      return value;
    };
  }

  it("canManageHost stays false and isProvisioning/error stay false/null with no hostManagement, regardless of enabled", () => {
    for (const enabled of [true, false]) {
      const lifecycle = mountLifecycleWithEnabled(makeHost(null), enabled)();

      expect(lifecycle.provisioning.canManageHost).toBe(false);
      expect(lifecycle.provisioning.isProvisioning).toBe(false);
      expect(lifecycle.provisioning.error).toBeNull();

      cleanup();
    }
  });

  // With no management, `hasManagement` and `canProvision` are both false, so the test above cannot tell which
  // one the field is gated on - swapping them is invisible to it (measured: that mutation survived it twice).
  it("reports canManageHost from management ALONE - true even when provisioning is not enabled", () => {
    const convergeReady = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { running: true, version: "1.2.3" },
      }),
    );
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: validSnapshot,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: makeHostManagement(convergeReady),
    });

    const lifecycle = mountLifecycleWithEnabled(host, false)();

    expect(lifecycle.provisioning.canManageHost).toBe(true);
  });
});

// lastProgress is retained only for the current attempt and exposed only after that attempt fails.
const EXTRACT_PROGRESS: MutationProgress = {
  stage: "extract",
  percent: 80,
  bytes: null,
  totalBytes: null,
  workUnits: null,
  message: null,
};

interface DeferredConverge {
  readonly promise: Promise<MutationOutcome<ConvergeReadyOk>>;
  readonly resolve: (value: MutationOutcome<ConvergeReadyOk>) => void;
}

function createDeferredConverge(): DeferredConverge {
  let resolveDeferred: (
    value: MutationOutcome<ConvergeReadyOk>,
  ) => void = () => {
    throw new Error("deferred converge resolver was not initialized");
  };
  const promise = new Promise<MutationOutcome<ConvergeReadyOk>>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function pushEnsureProgress(
  queryClient: QueryClient,
  management: IHostManagement,
  progress: MutationProgress | null,
  startedAt: string,
): void {
  act(() => {
    queryClient.setQueryData<HostControllerStatus>(
      runnerQueryKeys.hostControllerStatus(management),
      {
        ...IDLE_CONTROLLER_STATUS,
        mutation: {
          kind: "ensure",
          progress,
          startedAt,
        },
      },
    );
  });
}

describe("useHostProvisioning lastProgress producer", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.restoreAllMocks();
  });

  it("retains the last observed progress after an ensure attempt fails", async () => {
    const deferred = createDeferredConverge();
    const convergeReady = vi.fn(
      (): Promise<MutationOutcome<ConvergeReadyOk>> => {
        return deferred.promise;
      },
    );
    const management = makeHostManagement(convergeReady);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    // The automatic launch-time ensure is retired - the producer under test
    // is fed by user-initiated attempts now, so drive the first one directly.
    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(true);
    });

    pushEnsureProgress(
      queryClient,
      management,
      EXTRACT_PROGRESS,
      "2026-05-15T00:00:01Z",
    );
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.progress).toEqual(EXTRACT_PROGRESS);
    });
    // While pending, lastProgress must stay hidden (report surfaces only).
    expect(readLifecycle()?.provisioning.lastProgress).toBeNull();

    await act(async () => {
      deferred.resolve({ kind: "failed", message: "ensure failed" });
      await deferred.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(false);
      expect(readLifecycle()?.provisioning.error).not.toBeNull();
    });
    const provisioning = readLifecycle()?.provisioning;
    expect(provisioning?.progress).toBeNull();
    expect(provisioning?.lastProgress).toEqual(EXTRACT_PROGRESS);
  });

  it("exposes no lastProgress when the ensure attempt succeeds", async () => {
    const deferred = createDeferredConverge();
    const convergeReady = vi.fn(
      (): Promise<MutationOutcome<ConvergeReadyOk>> => {
        return deferred.promise;
      },
    );
    const management = makeHostManagement(convergeReady);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(true);
    });

    pushEnsureProgress(
      queryClient,
      management,
      EXTRACT_PROGRESS,
      "2026-05-15T00:00:01Z",
    );
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.progress).toEqual(EXTRACT_PROGRESS);
    });

    await act(async () => {
      deferred.resolve({
        kind: "ok",
        value: { running: true, version: "1.2.3" },
      });
      await deferred.promise;
    });

    await waitFor(() => {
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(false);
    });
    const provisioning = readLifecycle()?.provisioning;
    expect(provisioning?.error).toBeNull();
    expect(provisioning?.progress).toBeNull();
    // Success must leave nothing behind - exposure is gated on error.
    expect(provisioning?.lastProgress).toBeNull();
  });

  it("clears retained lastProgress when retry starts a new attempt", async () => {
    const settles: DeferredConverge[] = [];
    const convergeReady = vi.fn(
      (): Promise<MutationOutcome<ConvergeReadyOk>> => {
        const deferred = createDeferredConverge();
        settles.push(deferred);
        return deferred.promise;
      },
    );
    const management = makeHostManagement(convergeReady);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
      expect(settles).toHaveLength(1);
    });

    pushEnsureProgress(
      queryClient,
      management,
      EXTRACT_PROGRESS,
      "2026-05-15T00:00:01Z",
    );
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.progress).toEqual(EXTRACT_PROGRESS);
    });

    await act(async () => {
      settles[0].resolve({ kind: "failed", message: "ensure failed" });
      await settles[0].promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.lastProgress).toEqual(
        EXTRACT_PROGRESS,
      );
    });

    // Drop the prior attempt's status push before retry so the new attempt does not re-absorb the old ensure
    // progress the moment isPending flips true (progress is only live while pending.
    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        IDLE_CONTROLLER_STATUS,
      );
    });

    act(() => {
      readLifecycle()?.provisioning.retry();
    });

    // New attempt: cleared immediately, before any progress event arrives.
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(2);
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(true);
    });
    expect(readLifecycle()?.provisioning.progress).toBeNull();
    expect(readLifecycle()?.provisioning.lastProgress).toBeNull();
    expect(readLifecycle()?.provisioning.error).toBeNull();

    // Second attempt fails with no progress events: must not revive the old
    // stage (proves run() cleared the retained snapshot).
    await act(async () => {
      settles[1].resolve({ kind: "failed", message: "ensure failed again" });
      await settles[1].promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.error).not.toBeNull();
    });
    expect(readLifecycle()?.provisioning.lastProgress).toBeNull();
  });

  // Capture must read the status query cache at onError, not a prior render/effect.
  it("captures progress that arrives in the same commit as the failure", async () => {
    const deferred = createDeferredConverge();
    const convergeReady = vi.fn(
      (): Promise<MutationOutcome<ConvergeReadyOk>> => {
        return deferred.promise;
      },
    );
    const management = makeHostManagement(convergeReady);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(true);
    });
    // No progress yet - and no waitFor after the coalesced push below.
    expect(readLifecycle()?.provisioning.progress).toBeNull();

    await act(async () => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          ...IDLE_CONTROLLER_STATUS,
          mutation: {
            kind: "ensure",
            progress: EXTRACT_PROGRESS,
            startedAt: "2026-05-15T00:00:02Z",
          },
        },
      );
      deferred.resolve({ kind: "failed", message: "ensure failed" });
      await deferred.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(readLifecycle()?.provisioning.error).not.toBeNull();
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(false);
    });
    expect(readLifecycle()?.provisioning.progress).toBeNull();
    expect(readLifecycle()?.provisioning.lastProgress).toEqual(
      EXTRACT_PROGRESS,
    );
  });

  // Uncleared leftover ensure lane: run records that lane's startedAt as the attempt baseline, so a retry that
  // fails before its own progress event must report nothing - not the previous attempt's stage.
  it("ignores a leftover lane from a previous attempt on retry", async () => {
    const settles: DeferredConverge[] = [];
    const convergeReady = vi.fn(
      (): Promise<MutationOutcome<ConvergeReadyOk>> => {
        const deferred = createDeferredConverge();
        settles.push(deferred);
        return deferred.promise;
      },
    );
    const management = makeHostManagement(convergeReady);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);
    const firstLaneStartedAt = "2026-05-15T00:00:10Z";

    act(() => {
      readLifecycle()?.provisioning.retry();
    });
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
      expect(settles).toHaveLength(1);
    });

    pushEnsureProgress(
      queryClient,
      management,
      EXTRACT_PROGRESS,
      firstLaneStartedAt,
    );
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.progress).toEqual(EXTRACT_PROGRESS);
    });

    await act(async () => {
      settles[0].resolve({ kind: "failed", message: "ensure failed" });
      await settles[0].promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.lastProgress).toEqual(
        EXTRACT_PROGRESS,
      );
    });

    // Deliberately leave the ensure lane cached with firstLaneStartedAt. run must record that identity as the
    // baseline and refuse to re-report it.
    act(() => {
      readLifecycle()?.provisioning.retry();
    });

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(2);
      expect(readLifecycle()?.provisioning.isProvisioning).toBe(true);
    });
    expect(readLifecycle()?.provisioning.lastProgress).toBeNull();

    // Second attempt fails with no new progress push - only the leftover lane.
    await act(async () => {
      settles[1].resolve({ kind: "failed", message: "ensure failed again" });
      await settles[1].promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(readLifecycle()?.provisioning.error).not.toBeNull();
    });
    // startedAt baseline guard: leftover lane matches attemptBaseline and is dropped.
    expect(readLifecycle()?.provisioning.lastProgress).toBeNull();
  });
});

/** The same timer also governs the first-run download/install, a population that doc never contemplates, and
 * there 10s is routine. */
const DOWNLOAD_AT = (percent: number, bytes: number): MutationProgress => ({
  stage: "download",
  percent,
  bytes,
  totalBytes: 250_609_664,
  workUnits: null,
  message: "downloading host 1.2.3",
});

describe("HostProvisioningController - the staged wait versus live progress", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mountWithLane(): {
    readonly queryClient: QueryClient;
    readonly management: IHostManagement;
    readonly readLifecycle: () => HostProvisioningLifecycle | null;
  } {
    const management = makeHostManagement(() =>
      Promise.resolve({
        kind: "ok",
        value: { running: true, version: validSnapshot.version },
      }),
    );
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    });
    const { queryClient, readLifecycle } = mountProvisioningLifecycle(host);
    return { queryClient, management, readLifecycle };
  }

  it("does NOT promote to slow while the install is actively advancing past the threshold", () => {
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();
    expect(readLifecycle()?.slowStartStage).toBe("loading");

    // A real download: advancing events, wall-clock well past the threshold.
    for (const [percent, bytes] of [
      [10, 25_000_000],
      [30, 75_000_000],
      [60, 150_000_000],
      [85, 210_000_000],
    ] as ReadonlyArray<readonly [number, number]>) {
      pushEnsureProgress(
        queryClient,
        management,
        DOWNLOAD_AT(percent, bytes),
        "2026-05-15T00:00:01Z",
      );
      act(() => {
        vi.advanceTimersByTime(LOCAL_HOST_SLOW_START_THRESHOLD_MS - 1_000);
      });
    }

    // Total elapsed is ~36s, far beyond the threshold, and the snapshot is still unavailable - so the only thing
    // that may keep this out of `slow` is the progress itself.
    expect(readLifecycle()?.localHostState).toBe("unavailable");
    expect(readLifecycle()?.slowStartStage).toBe("loading");
  });

  it("STILL promotes to slow when the lane is chatty but stuck at the same point", () => {
    // A stalled download that keeps re-emitting the same percent would reset an arrival-keyed timer for ever, and
    // the escape hatch would never appear for the user who most needs it.
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();
    expect(readLifecycle()?.slowStartStage).toBe("loading");

    const gapMs = LOCAL_HOST_SLOW_START_THRESHOLD_MS / 4 + 100;
    for (let i = 0; i < 7; i += 1) {
      pushEnsureProgress(
        queryClient,
        management,
        // Byte-identical every time: chatty, not advancing.
        DOWNLOAD_AT(42, 105_000_000),
        "2026-05-15T00:00:01Z",
      );
      act(() => {
        vi.advanceTimersByTime(gapMs);
      });
      // Guard against the assertion below passing because one gap was long enough: that would make this test pass on
      // the arrival-keyed build it exists to reject.
      expect(gapMs).toBeLessThan(LOCAL_HOST_SLOW_START_THRESHOLD_MS);
    }

    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("DEMOTES back to loading when a promoted install starts advancing again", () => {
    // Reachable in production, and by the ordinary path: `verify` hashes ~800MB emitting one constant position, so
    // a first launch crosses the threshold before extraction's per-entry heartbeat starts moving at all.
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();

    // A pushed position is not an observed one: the query notifies on its own schedule, so without settling here
    // the first advance would still be arriving on the render the promotion timer triggers.
    const settleObservation = (): void => {
      act(() => {
        vi.advanceTimersByTime(1);
      });
    };

    pushEnsureProgress(
      queryClient,
      management,
      DOWNLOAD_AT(10, 25_000_000),
      "2026-05-15T00:00:01Z",
    );
    settleObservation();
    advancePastSlowStartThreshold();
    // Premise: it really did promote, on a position the wait had already seen. Without this the demotion below is
    // satisfied by a build that never promoted in the first place.
    expect(readLifecycle()?.slowStartStage).toBe("slow");

    pushEnsureProgress(
      queryClient,
      management,
      DOWNLOAD_AT(35, 90_000_000),
      "2026-05-15T00:00:01Z",
    );
    settleObservation();
    expect(readLifecycle()?.slowStartStage).toBe("loading");

    // And the detection is unweakened - the demotion re-arms the timer from the new position rather than disabling
    // it. Without this arm, "never promote again" would pass just as happily as the fix.
    advancePastSlowStartThreshold();
    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("STILL promotes to slow for a lane accepted but silent", () => {
    // `useHostProvisioningProgress` is explicit that a null `progress` on a running lane means "accepted but has
    // not pushed an event" rather than "no progress yet".
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();

    pushEnsureProgress(queryClient, management, null, "2026-05-15T00:00:01Z");
    advancePastSlowStartThreshold();
    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("does NOT promote during a bundled first launch - the local-source path the desktop actually takes", () => {
    // `download` - the only stage that emits an advancing position - never runs at all.
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();

    const push = (progress: MutationProgress): void => {
      pushEnsureProgress(
        queryClient,
        management,
        progress,
        "2026-05-15T00:00:01Z",
      );
    };

    // verify: announce, then hash an 800MB archive, reporting the position the stream already knew. Chunked so the
    // wall clock passes the threshold with no single gap reaching it - the same arithmetic as the chatty arm.
    push({
      stage: "verify",
      message: "hashing /Applications/Traycer.app/…/host-runtime.tar.gz",
      percent: null,
      bytes: null,
      totalBytes: 838_860_800,
      workUnits: null,
    });
    for (const hashed of [200_000_000, 400_000_000, 600_000_000, 838_860_800]) {
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      push({
        stage: "verify",
        message: "hashing /Applications/Traycer.app/…/host-runtime.tar.gz",
        percent: null,
        bytes: hashed,
        totalBytes: 838_860_800,
        workUnits: null,
      });
    }

    // extract: announce, then heartbeats every 2s for a minute.
    push({
      stage: "extract",
      message: "extracting host archive into /tmp/staging",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    // The throttled heartbeat, every 2s, carrying a rising entry count - the only field that differs between two
    // of them.
    for (let i = 0; i < 30; i += 1) {
      push({
        stage: "extract",
        message: "extracting host 1.2.3",
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: (i + 1) * 40,
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
    }

    // Nothing has failed. The install is working. Retry must not be on screen.
    expect(readLifecycle()?.slowStartStage).toBe("loading");
  });

  it("STILL promotes to slow when NO lane event ever arrives - the wait is baselined at mount", () => {
    // If the wait were baselined only by the first advance, this shape would never promote: no Retry, no Report
    // issue, just a screen that sits there.
    vi.useFakeTimers();
    const { readLifecycle } = mountWithLane();

    // Nothing pushed at all: no mutation on the lane, no progress, ever.
    expect(readLifecycle()?.slowStartStage).toBe("loading");
    advancePastSlowStartThreshold();

    expect(readLifecycle()?.slowStartStage).toBe("slow");
    expect(readLifecycle()?.localHostState).toBe("unavailable");
  });

  /** attempt 1 - `progress: null` (the arm above): short-circuits on the key's first guard, so the all-null
   * branch is never evaluated. */
});
