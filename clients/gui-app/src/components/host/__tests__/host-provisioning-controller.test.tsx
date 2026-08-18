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
    cliManifest: () => Promise.resolve(null),
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
    // Published from the commit phase, not during render (react-hooks/globals):
    // every assertion runs after an `act`/`waitFor`, by which point effects
    // have flushed, so `readLifecycle` still sees the latest committed value.
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

    // `IRunnerHost.onLocalHostChange` is required to fire synchronously on
    // subscribe, so by the time effects settle the state has already moved
    // past `unknown` (`state === null`) to the derived `unavailable`. See
    // the next test for the genuinely-unknown window on a runner that
    // defers its first emission.
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
    // The stage must be `slow` BEFORE the host comes up, or this proves
    // nothing: a wait that never left `loading` reads `loading` afterwards
    // whether or not anything restarts it, and the assertion passes on the
    // null hypothesis. So: stall a start until it promotes, let the host
    // arrive, then take it away - now `loading` can only be explained by the
    // restart, and deleting that line leaves this reading `slow`.
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
    // Simulates the desktop bridge timing: the runner host received its
    // initial local-host snapshot before the controller mounted. The
    // subscription must still see the current value synchronously so the
    // lifecycle does not stall at `unknown`.
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

  // The forced-update GESTURE. What this component owns - and what a user's
  // data depends on - is that the forced path asks for force, and the
  // ordinary Retry path does not.
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

    // THE AUTHORITY CONVERGES TOO, and through this same spy. D14 wants a
    // never-dialed local host, so the in-process authority requests an ensure
    // at construction and `MockRunnerHost` routes it to
    // `hostManagement.convergeReady` exactly as the real desktop port does.
    // Settling it here is what makes the counts below describe the GESTURES
    // rather than a race between two actors.
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

  // The busy-keep LATCH: a "busy" convergeReady outcome must keep the caller
  // off the still-unprobed busy host, and that must survive both a plain
  // Refresh and a forced update.
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

    // Refresh: re-check the busy status without forcing. LATCHED - the point
    // of `markBusyKeep` is that only a success clears it, so a second busy
    // answer must not read as recovery.
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

  // Kills: dropping the `toastFromRunnerError` in `reinstall()`'s rejection
  // handler. The state restore below is NOT the feedback - the Reinstall
  // button reappearing is indistinguishable from a click that never
  // registered, which is the whole defect.
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
    // The REJECTION REASON reaches the shared handler, not a swallowed
    // generic: a typed bridge error keeps its own message there.
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

    // A later settle with running:true (e.g. after a successful reinstall)
    // clears the latch and its cache mirror - it must not survive an
    // unrelated success the way the busy-keep latch's own settle would.
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

  // Kills: dropping the optimistic `setRemoved(false)` / cache write in
  // `reinstall()`, or calling `run()` before `clearRemoval()` resolves
  // instead of after.
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

  // Kills: dropping the `clearRemoval()` rejection handler in `reinstall()`,
  // or leaving `removed`/its cache mirror on the optimistic `false` after a
  // failed clear - the arm most likely to rot silently, since the happy path
  // never exercises it.
  it("a rejected clearRemoval() restores removed and its cache mirror instead of leaving a resolved spinner", async () => {
    const convergeReady = vi.fn((): Promise<MutationOutcome<ConvergeReadyOk>> =>
      Promise.resolve({ kind: "ok", value: { running: false, version: null } }),
    );
    const baseManagement = makeHostManagement(convergeReady);
    const clearRemovalRejection = new Error("clearRemoval failed");
    const clearRemovalPromise = Promise.reject<void>(clearRemovalRejection);
    // Attach a no-op catch immediately so the still-pending assertion promise
    // below is not the first handler and vitest never reports this as an
    // unhandled rejection while it is in flight.
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

  // Returns an ACCESSOR, like `mountProvisioningLifecycle` above, rather than
  // the captured value: the capture happens inside an effect closure, so a
  // narrowed local read straight after `render` is `null` as far as the type
  // flow is concerned - which turns its own guard into a comparison that is
  // always true, and a guard that cannot fail is not a guard.
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

  // THE DISCRIMINATOR. With no management, `hasManagement` and `canProvision`
  // are both false, so the test above cannot tell which one the field is
  // gated on - swapping them is invisible to it (measured: that mutation
  // survived it twice). Management PRESENT with `enabled` false is the only
  // shape where the two disagree, and it is the shape production actually
  // hits: `canProvision` collapses the instant a busy host is surfaced, and
  // gating there would hide Retry/forced-update progress and swallow their
  // errors on a machine this app manages.
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

// Producer-level coverage for `useHostProvisioning`'s retained progress
// (traycer#862 / #4747). Live progress is sourced from the shared
// HostControllerStatus mutation lane (pushed the same way production's
// HostControllerStatusListener does). lastProgress is retained only for the
// current attempt and exposed only after that attempt FAILS.
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

    // Drop the prior attempt's status push BEFORE retry so the new attempt
    // does not re-absorb the old ensure progress the moment isPending flips
    // true (progress is only live while pending; clearing now is a no-op for
    // live progress and only prevents a stale re-feed).
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

  // The desktop status push can land in the same React commit as the
  // mutation settlement: progress never becomes a render-observed value
  // while isPending (it arrives as isPending flips false). Capture must
  // read the status query cache at onError, not a prior render/effect.
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

  // Uncleared leftover ensure lane: run() records that lane's startedAt as
  // the attempt baseline, so a retry that fails before its own progress
  // event must report nothing - not the previous attempt's stage.
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

    // Deliberately leave the ensure lane CACHED with firstLaneStartedAt.
    // run() must record that identity as the baseline and refuse to re-report it.
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

/**
 * THE STAGED WAIT VERSUS LIVE PROGRESS.
 *
 * `slow` is what puts Retry in front of the user, and its threshold's own doc
 * justifies 10s against a healthy bundled-host BOOT - "typically well under a
 * second", so a 10x margin. The same timer also governs the first-run
 * download/install, a population that doc never contemplates, and there 10s is
 * routine. A threshold justified against one population silently governed every
 * other population sharing its timer.
 *
 * Progress is read from the MUTATION LANE, not from `provisioning.progress`.
 * That is not a style choice: a first launch is driven by the desktop's own
 * reconciler, so a renderer-side mutation observer sees no episode at all and
 * `isProvisioning` is false throughout - see `useHostProvisioningProgress`,
 * which exists because of exactly that. Keying this on the renderer's own
 * mutation state would have fixed nothing for the only population that hits it.
 */
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
    // Nothing has failed, the progress bar is on screen, and the user is being
    // told to Retry - which is the complaint that started this whole epic.
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

    // Total elapsed is ~36s, far beyond the threshold, and the snapshot is still
    // unavailable - so the ONLY thing that may keep this out of `slow` is the
    // progress itself.
    expect(readLifecycle()?.localHostState).toBe("unavailable");
    expect(readLifecycle()?.slowStartStage).toBe("loading");
  });

  it("STILL promotes to slow when the lane is chatty but stuck at the same point", () => {
    // The over-suppression guard, and the reason the predicate keys on the lane
    // reaching a NEW POSITION rather than on a progress event ARRIVING. A stalled
    // download that keeps re-emitting the same percent would reset an
    // arrival-keyed timer for ever, and the escape hatch would never appear for
    // the user who most needs it.
    //
    // THE ARITHMETIC IS THE TEST. No single gap here reaches the threshold, so an
    // arrival-keyed timer never fires; the total time since the lane last MOVED
    // does, so a position-keyed one does. Measured while building this: the first
    // observed position is itself a real advance (null is not a position), so the
    // clock that matters starts at the first event and not at mount - an earlier
    // version of this test assumed otherwise and failed for that reason rather
    // than for the behaviour it was checking.
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
      // Guard against the assertion below passing because ONE gap was long
      // enough: that would make this test pass on the arrival-keyed build it
      // exists to reject.
      expect(gapMs).toBeLessThan(LOCAL_HOST_SLOW_START_THRESHOLD_MS);
    }

    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("DEMOTES back to loading when a promoted install starts advancing again", () => {
    // `slow` used to be ABSORBING: the timer effect returns early on
    // `stage === "slow"`, so once the wait promoted, no later event could take
    // it back down - only reaching `ready` ever cleared it. An install that
    // went quiet for eleven seconds and then resumed kept Retry and the
    // emphasized recovery controls on screen for the rest of a healthy run.
    //
    // Reachable in production, and by the ordinary path: `verify` hashes ~800MB
    // emitting one constant position, so a first launch crosses the threshold
    // before extraction's per-entry heartbeat starts moving at all.
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();

    // A pushed position is not an OBSERVED one: the query notifies on its own
    // schedule, so without settling here the first advance would still be
    // arriving on the render the promotion timer triggers - and this arm would
    // then be measuring that coincidence rather than the demotion. Measured,
    // not assumed: instrumenting the controller showed the first advance and
    // `stage === "slow"` reaching the same render.
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
    // Premise: it really did promote, on a position the wait had already seen.
    // Without this the demotion below is satisfied by a build that never
    // promoted in the first place.
    expect(readLifecycle()?.slowStartStage).toBe("slow");

    pushEnsureProgress(
      queryClient,
      management,
      DOWNLOAD_AT(35, 90_000_000),
      "2026-05-15T00:00:01Z",
    );
    settleObservation();
    expect(readLifecycle()?.slowStartStage).toBe("loading");

    // And the detection is UNWEAKENED - the demotion re-arms the timer from
    // the new position rather than disabling it. Without this arm, "never
    // promote again" would pass just as happily as the fix.
    advancePastSlowStartThreshold();
    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("STILL promotes to slow for a lane accepted but silent", () => {
    // `useHostProvisioningProgress` is explicit that a null `progress` on a
    // RUNNING lane means "accepted but has not pushed an event" rather than "no
    // progress yet" - so an install that was accepted and then said nothing for
    // the whole threshold is precisely the stall this stage exists to surface.
    vi.useFakeTimers();
    const { queryClient, management, readLifecycle } = mountWithLane();

    pushEnsureProgress(queryClient, management, null, "2026-05-15T00:00:01Z");
    advancePastSlowStartThreshold();
    expect(readLifecycle()?.slowStartStage).toBe("slow");
  });

  it("does NOT promote during a bundled first launch - the local-source path the desktop actually takes", () => {
    // The payloads below are the REAL first-launch emissions, not a synthetic
    // lane. Quoted from the producer, which never runs `download` on this path:
    //
    //   installer/bundled-host.ts:6-11  - production desktop bundles ship the
    //     archive beside the CLI, so `host ensure` takes the LOCAL-SOURCE path.
    //     `download` - the only stage that emits an advancing position - never
    //     runs at all.
    //   installer/install.ts:709-714    - verify: stage "verify", percent null,
    //     bytes null, totalBytes = the archive size. `totalBytes` is excluded
    //     from the position key by design (a size is not a position), so this is
    //     CONSTANT while it hashes ~800 MB.
    //   installer/install.ts:236-241    - extract announce, all comparable
    //     fields null.
    //   installer/extract-heartbeat.ts:41-47 - every 2s, throttled, per archive
    //     entry: stage "extract", message `extracting host <version>`, percent
    //     null, bytes null, totalBytes null. CONSTANT for the whole extract,
    //     which that file's own comment says "can run for minutes".
    //
    // So the position key is "verify||" for the whole hash and "extract||" for
    // the whole extract: two advances in total, minutes apart.
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

    // verify: announce, then hash an 800MB archive, reporting the position the
    // stream already knew. Chunked so the wall clock passes the threshold with no
    // single gap reaching it - the same arithmetic as the chatty arm.
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
    // The throttled heartbeat, every 2s, carrying a RISING entry count - the only
    // field that differs between two of them. Every other field is byte-identical
    // by construction.
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
    // THE MOST IMPORTANT ARM ON THIS SURFACE, and the one whose failure direction
    // is unacceptable to leave inferred.
    //
    // A host process that never spawns is the commonest hard failure, and it
    // produces a boot with no lane event at all - so there is never a "first
    // position" to start a clock from. If the wait were baselined only by the
    // first advance, this shape would NEVER promote: no Retry, no Report issue,
    // just a screen that sits there. That is strictly worse than the defect this
    // fix addresses, and silent where that one at least showed a button.
    //
    // So the timer is armed from MOUNT and progress RESETS it, rather than
    // progress arming it. Asserted rather than reasoned about: the mutation that
    // arms it on first advance instead reddens exactly this test.
    vi.useFakeTimers();
    const { readLifecycle } = mountWithLane();

    // Nothing pushed at all: no mutation on the lane, no progress, ever.
    expect(readLifecycle()?.slowStartStage).toBe("loading");
    advancePastSlowStartThreshold();

    expect(readLifecycle()?.slowStartStage).toBe("slow");
    expect(readLifecycle()?.localHostState).toBe("unavailable");
  });

  /**
   * DECLARED GAP: `laneProgressAdvanceKey`'s "all comparable fields null" branch
   * is NOT pinned by anything above, and three attempts at an arm for it were
   * each vacuous. Recorded rather than left to read as covered.
   *
   *   attempt 1 - `progress: null` (the arm above): short-circuits on the key's
   *     FIRST guard, so the all-null branch is never evaluated.
   *   attempt 2 - a repeating message-only event: the mutated key is a CONSTANT,
   *     exactly as stable as `null`, so the wait restarts once at t≈0 either way
   *     and promotes on the same schedule.
   *   attempt 3 - a LATE message-only event, which should have distinguished
   *     them: instrumented and confirmed the lane lands and the mutated key is
   *     live, yet the promotion time did not move. Whatever absorbs it is in the
   *     effect/fake-timer interaction, not in the predicate.
   *
   * So the branch is DEFENSIVE and unproven: mutating it to report an advance
   * passes this whole suite. It is kept because a message is genuinely not
   * evidence of movement and the alternative fails toward withholding the escape
   * hatch - but nobody should read the green suite as having checked it. Anyone
   * touching it should reach for a real-browser or integration-level measurement
   * rather than trusting these arms.
   */
});
