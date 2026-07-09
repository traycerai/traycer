import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import type {
  HostEnsureResult,
  IHostManagement,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  GATE_BYPASS_PATH_PREFIX,
  LOCAL_HOST_SLOW_START_THRESHOLD_MS,
  LocalHostGate,
  LocalHostUnavailable,
} from "@/components/local-host-gate";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  useHostClient,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  createPersistentMemoryHistory,
  getHistoryController,
} from "@/lib/persistent-history";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import {
  resetSystemTabModalColdLoadForTests,
  useSystemTabModalController,
  useSystemTabModalRefreshGuard,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";

const validSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

const localEntry: HostDirectoryEntry = {
  hostId: validSnapshot.hostId,
  label: validSnapshot.displayName,
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  status: "available",
};

const remoteEntry: HostDirectoryEntry = {
  hostId: "remote-host-1",
  label: "Remote Host",
  kind: "remote",
  websocketUrl: "wss://relay.example.com/rpc",
  version: "1.2.3",
  status: "available",
};

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;
type HostStatusHandler = () => Promise<HostStatusResponse> | HostStatusResponse;

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
};

let activeMessenger: MockHostMessenger<HostRpcRegistry> | null = null;
let restoreFetch: () => void = () => undefined;

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

function makeHostManagement(
  ensureHost: IHostManagement["ensureHost"],
): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} not implemented in this test`));
  return {
    installHost: notImplemented("installHost"),
    updateHost: notImplemented("updateHost"),
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
    ensureHost,
    deregisterService: notImplemented("deregisterService"),
    registryCheck: notImplemented("registryCheck"),
    getOperationStatus: () => Promise.resolve(null),
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

function withQueryClient(children: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={buildQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function seedStoredToken(host: MockRunnerHost): void {
  void host.tokenStore.set({
    token: "test-token",
    refreshToken: "test-refresh-token",
  });
}

function buildMessengerFactory(
  hostStatus: HostStatusHandler,
): MessengerFactory<HostRpcRegistry> {
  return (args) => {
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "host.status": () => hostStatus(),
        "epic.listTasks": () => ({
          tasks: [],
          hasMore: false,
        }),
      },
    });
    activeMessenger = messenger;
    return messenger;
  };
}

function mountGate(
  host: MockRunnerHost,
  selectedEntry: HostDirectoryEntry | null,
): void {
  render(
    withQueryClient(
      <RunnerHostProvider runnerHost={host}>
        <LocalHostGate
          bypass={false}
          selectedEntry={selectedEntry}
          loading={
            <div data-testid="gate-loading">Starting local Traycer Host…</div>
          }
          provisioningLoading={null}
          unavailable={<div data-testid="gate-unavailable">unavailable</div>}
        >
          <div data-testid="gate-children">children</div>
        </LocalHostGate>
      </RunnerHostProvider>,
    ),
  );
}

function mountGateWithRuntime(
  host: MockRunnerHost,
  selectedEntry: HostDirectoryEntry | null,
  hostStatus: HostStatusHandler,
  children: ReactNode,
): void {
  if (useAuthStore.getState().status === "signed-in") {
    seedStoredToken(host);
  }
  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={buildQueryClient()}>
        <TooltipProvider>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={buildMessengerFactory(hostStatus)}
            invalidator={null}
            requestId={null}
            remoteFetcher={() => Promise.resolve([])}
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <HostCompatibilityProvider>
              <LocalHostGate
                bypass={false}
                selectedEntry={selectedEntry}
                loading={
                  <div data-testid="gate-loading">
                    Starting local Traycer Host…
                  </div>
                }
                provisioningLoading={null}
                unavailable={
                  <div data-testid="gate-unavailable">unavailable</div>
                }
              >
                {children}
              </LocalHostGate>
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

function HostBackedTasksProbe(): ReactNode {
  const client = useHostClient();
  useHostQuery<HostRpcRegistry, "epic.listTasks">({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listTasks",
    params: {
      limit: 20,
      filters: null,
      sort: "recent",
      extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
      extensionEpicVersion: String(CURRENT_EPIC_VERSION),
    },
    options: null,
  });
  return <div data-testid="gate-children">children</div>;
}

function mountGateWithRealUnavailable(
  host: MockRunnerHost,
  selectedEntry: HostDirectoryEntry | null,
): void {
  render(
    withQueryClient(
      <RunnerHostProvider runnerHost={host}>
        <LocalHostGate
          bypass={false}
          selectedEntry={selectedEntry}
          loading={
            <div data-testid="gate-loading">Starting local Traycer Host…</div>
          }
          provisioningLoading={null}
          unavailable={
            <LocalHostUnavailable message="Local host is taking longer than usual to start." />
          }
        >
          <div data-testid="gate-children">children</div>
        </LocalHostGate>
      </RunnerHostProvider>,
    ),
  );
}

function advancePastSlowStartThreshold(): void {
  act(() => {
    vi.advanceTimersByTime(LOCAL_HOST_SLOW_START_THRESHOLD_MS + 10);
  });
}

function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: "user-1",
                name: "Test User",
                providerId: "gh-1",
                providerHandle: "test-user",
                providerType: "GITHUB",
                email: "test@example.com",
                avatarUrl: null,
                activatedAt: null,
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                lastSeenAt: null,
                privacyMode: false,
                isLearningEnabled: true,
              },
              userSubscription: {
                id: "sub-1",
                userID: "user-1",
                orgID: null,
                teamID: null,
                customerId: "cus-1",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                subscriptionExpiry: null,
                trialEndsAt: null,
                subscriptionStatus: "FREE",
                hasPaymentMethod: false,
                isInTrial: false,
                rechargeRateSeconds: 0,
              },
              teamSubscriptions: [],
              payAsYouGoUsage: { allowPayAsYouGo: false },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in local-host-gate test: ${url}`),
      );
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

describe("LocalHostGate", () => {
  beforeEach(() => {
    activeMessenger = null;
    restoreFetch = installAuthFetch();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("passes children through when the user is signed out, even on a null snapshot", () => {
    mountGate(makeHost(null), localEntry);

    expect(screen.queryByTestId("gate-children")).not.toBeNull();
    expect(screen.queryByTestId("gate-loading")).toBeNull();
    expect(screen.queryByTestId("gate-unavailable")).toBeNull();
  });

  it("passes children through for non-local entries even on a null snapshot", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGate(makeHost(null), remoteEntry);

    expect(screen.queryByTestId("gate-children")).not.toBeNull();
    expect(screen.queryByTestId("gate-loading")).toBeNull();
    expect(screen.queryByTestId("gate-unavailable")).toBeNull();
  });

  it("holds in Stage 1 loading on mount when the runner emits a null snapshot - no Retry visible yet", () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRealUnavailable(makeHost(null), localEntry);

    expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    expect(screen.queryByTestId("gate-loading")?.textContent).toContain(
      "Starting local Traycer Host…",
    );
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(screen.queryByTestId("local-host-unavailable")).toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();
  });

  it("does not provision until the initial local-host snapshot has been observed", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const ensureHost = vi.fn((): Promise<HostEnsureResult> =>
      Promise.resolve({
        action: "provisioned",
        running: true,
        version: "1.2.3",
      }),
    );
    const host = new DeferredInitialSnapshotHost(
      null,
      makeHostManagement(ensureHost),
    );

    mountGate(host, localEntry);

    expect(ensureHost).not.toHaveBeenCalled();

    act(() => {
      host.emitInitialSnapshot();
    });

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(1);
    });
  });

  it("promotes to Stage 2 unavailable with a clickable Retry once the slow-start threshold elapses", async () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const host = makeHost(null);
    mountGateWithRealUnavailable(host, localEntry);

    // Stage 1: still loading, no Retry.
    expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();

    advancePastSlowStartThreshold();

    // Stage 2: slower-start copy and a reachable Retry.
    expect(screen.queryByTestId("gate-loading")).toBeNull();
    expect(screen.queryByTestId("local-host-unavailable")).not.toBeNull();
    const retry = screen.getByTestId("local-host-retry");
    expect(retry).not.toBeNull();
    expect(host.requestHostRespawnCalls).toBe(0);

    // Click Retry on real timers so startTransition / waitFor can flush.
    vi.useRealTimers();
    fireEvent.click(retry);
    await waitFor(() => {
      expect(host.requestHostRespawnCalls).toBe(1);
    });
  });

  it("auto-transitions from Stage 1 loading to children when a valid snapshot arrives", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const host = makeHost(null);
    mountGateWithRuntime(
      host,
      localEntry,
      () => compatibleHostStatus,
      <div data-testid="gate-children">children</div>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    });

    act(() => {
      host.setLocalHost(validSnapshot);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
    expect(screen.queryByTestId("gate-loading")).toBeNull();
    expect(screen.queryByTestId("local-host-unavailable")).toBeNull();
  });

  it("renders children when the initial snapshot has both URLs", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      makeHost(validSnapshot),
      localEntry,
      () => compatibleHostStatus,
      <div data-testid="gate-children">children</div>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
  });

  it("keeps the initializing host card while the initial compatibility probe is pending", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      makeHost(validSnapshot),
      localEntry,
      () => new Promise<HostStatusResponse>(() => undefined),
      <div data-testid="gate-children">children</div>,
    );

    expect(await screen.findByTestId("gate-loading")).not.toBeNull();
    expect(screen.queryByTestId("local-host-compat-checking")).toBeNull();
    expect(screen.queryByTestId("local-host-incompatible")).toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();
  });

  it("blocks children and shows the protocol reason when the initial host is incompatible", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      makeHost(validSnapshot),
      localEntry,
      () => {
        throw new HostRpcError({
          code: "INCOMPATIBLE",
          message: "Incompatible methods: worktree.readScriptsAtRef",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      <HostBackedTasksProbe />,
    );

    expect(await screen.findByTestId("local-host-incompatible")).not.toBeNull();
    expect(
      screen.getByTestId("local-host-incompatible-reason").textContent,
    ).toContain("Incompatible methods: worktree.readScriptsAtRef");
    expect(screen.queryByText(/Force restart/i)).toBeNull();
    expect(screen.queryByText(/Force update/i)).toBeNull();
    expect(screen.queryByText(/Retry check/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Update host" })).toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();
    expect(activeMessenger?.calls.map((entry) => entry.method)).not.toContain(
      "epic.listTasks",
    );
  });

  it("shows a retryable error when the compatibility probe fails after retries", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      makeHost(validSnapshot),
      localEntry,
      () => {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "status probe failed",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      <div data-testid="gate-children">children</div>,
    );

    expect(
      await screen.findByText(
        "Could not verify host compatibility. status probe failed",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();
  });

  it("treats downgrade-unsupported as a terminal normal-launch compatibility failure", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      makeHost(validSnapshot),
      localEntry,
      () => {
        throw new HostRpcError({
          code: "DOWNGRADE_UNSUPPORTED",
          message: "No downgrade bridge for called method",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      <div data-testid="gate-children">children</div>,
    );

    expect(await screen.findByTestId("local-host-incompatible")).not.toBeNull();
    expect(
      screen.getByTestId("local-host-incompatible-reason").textContent,
    ).toContain("No downgrade bridge for called method");
    expect(screen.queryByTestId("gate-children")).toBeNull();
  });

  it("normal-launch Update host calls ensureHost with force=true", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const ensureHost = vi.fn((): Promise<HostEnsureResult> =>
      Promise.resolve({
        action: "provisioned",
        running: true,
        version: "1.2.4",
      }),
    );
    mountGateWithRuntime(
      new MockRunnerHost({
        signInUrl: "https://auth.traycer.invalid/sign-in",
        authnBaseUrl: "http://localhost:5005",
        localHost: validSnapshot,
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: undefined,
        traycerCli: undefined,
        hostManagement: makeHostManagement(ensureHost),
      }),
      localEntry,
      () => {
        throw new HostRpcError({
          code: "INCOMPATIBLE",
          message: "Incompatible methods",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      <div data-testid="gate-children">children</div>,
    );

    const update = await screen.findByRole("button", { name: "Update host" });
    fireEvent.click(update);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      );
    });
  });

  it("busy incompatible host can refresh busy status or force update", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const hostRef: { current: MockRunnerHost | null } = { current: null };
    const ensureHost = vi.fn((): Promise<HostEnsureResult> => {
      const currentHost = hostRef.current;
      if (currentHost === null) {
        return Promise.reject(new Error("host not mounted"));
      }
      currentHost.setLocalHost(validSnapshot);
      return Promise.resolve({
        action: "host-busy",
        running: true,
        version: "1.2.3",
      });
    });
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: makeHostManagement(ensureHost),
    });
    hostRef.current = host;

    mountGateWithRuntime(
      host,
      localEntry,
      () => {
        throw new HostRpcError({
          code: "INCOMPATIBLE",
          message: "Incompatible methods: epic.listTasks",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      <div data-testid="gate-children">children</div>,
    );

    expect(
      await screen.findByTestId("local-host-incompatible-busy"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("local-host-incompatible-reason").textContent,
    ).toContain("Incompatible methods: epic.listTasks");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(
      screen.getByRole("button", { name: "Force update host" }),
    ).not.toBeNull();
    expect(screen.queryByText(/Force restart/i)).toBeNull();
    expect(screen.queryByText(/Retry update/i)).toBeNull();

    fireEvent.click(refresh);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(2);
    });
    expect(ensureHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: false }),
    );

    const forceUpdate = await screen.findByRole("button", {
      name: "Force update host",
    });
    fireEvent.click(forceUpdate);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(3);
    });
    expect(ensureHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("flips from children to Stage 1 loading, then Stage 2 unavailable, when a previously-valid snapshot becomes null", async () => {
    const host = makeHost(validSnapshot);
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      host,
      localEntry,
      () => compatibleHostStatus,
      <div data-testid="gate-children">children</div>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });

    vi.useFakeTimers();

    act(() => {
      host.setLocalHost(null);
    });

    // Ready → not-ready resets to Stage 1 loading first.
    expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    expect(screen.queryByTestId("gate-unavailable")).toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();

    advancePastSlowStartThreshold();

    expect(screen.queryByTestId("gate-unavailable")).not.toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();
  });

  it("renders unavailable after the slow-start threshold when the snapshot is missing a URL", () => {
    vi.useFakeTimers();
    const partial: LocalHostSnapshot = { ...validSnapshot, websocketUrl: "" };
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGate(makeHost(partial), localEntry);

    // Stage 1 first - invalid snapshot is still "waiting" and must not flash
    // Retry immediately.
    expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    expect(screen.queryByTestId("gate-unavailable")).toBeNull();

    advancePastSlowStartThreshold();

    expect(screen.queryByTestId("gate-unavailable")).not.toBeNull();
  });

  it("replays the current snapshot to a subscriber that mounts after the host already has a value", async () => {
    // Simulates the desktop bridge timing: the runner host received its
    // initial local-host snapshot before the gate mounted. The gate's
    // `onLocalHostChange` subscription must still see the current value
    // synchronously so the UI does not stall in `loading`.
    const host = makeHost(null);
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    host.setLocalHost(validSnapshot);

    let subscribeCount = 0;
    const originalSubscribe = host.onLocalHostChange.bind(host);
    host.onLocalHostChange = (handler) => {
      subscribeCount += 1;
      return originalSubscribe(handler);
    };

    mountGateWithRuntime(
      host,
      localEntry,
      () => compatibleHostStatus,
      <div data-testid="gate-children">children</div>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
    expect(subscribeCount).toBeGreaterThanOrEqual(1);
  });

  it("holds the Flow 5 gap for a signed-in user with no selection yet - Stage 1 loading, then Stage 2 unavailable", () => {
    // Flow 5 gap: the app has mounted signed-in before auto-bind flips the
    // selection to the local entry. The gate must hold this gap with the
    // staged waiting surface rather than passing through to an inline
    // placeholder downstream.
    vi.useFakeTimers();
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGate(makeHost(null), null);

    expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    expect(screen.queryByTestId("gate-unavailable")).toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();

    advancePastSlowStartThreshold();

    expect(screen.queryByTestId("gate-unavailable")).not.toBeNull();
    expect(screen.queryByTestId("gate-children")).toBeNull();
  });

  it("renders children for a signed-in user with no selection yet once the local snapshot is valid (auto-bind transition)", async () => {
    // Paired with the auto-bind fix: the selection flips from null to the
    // local entry once the local snapshot arrives. While `selectedEntry` is
    // still null, the gate already resolves to children because the runner
    // emits a valid snapshot synchronously on subscribe.
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountGateWithRuntime(
      makeHost(validSnapshot),
      null,
      () => compatibleHostStatus,
      <div data-testid="gate-children">children</div>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
  });

  it("passes children through for a signed-in user when the runner host does not expose a local host", () => {
    // Mobile / non-local-host shells: `hasLocalHost === false` opts out
    // of the signed-in local-host gate so the shell-specific UX
    // (e.g. `<MobileHostGate />`) can render instead of the desktop
    // Retry card.
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in?shell=mobile",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      hasLocalHost: false,
      workspaceFolderPickerPaths: undefined,
      traycerCli: undefined,
    });
    mountGate(host, null);

    expect(screen.queryByTestId("gate-children")).not.toBeNull();
    expect(screen.queryByTestId("gate-unavailable")).toBeNull();
    expect(screen.queryByTestId("gate-loading")).toBeNull();
  });
});

describe("LocalHostGate structural stability across the /settings bypass boundary", () => {
  beforeEach(() => {
    restoreFetch = installAuthFetch();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("does not remount children when bypass flips true<->false while the host stays ready", async () => {
    // Regression coverage for the back-navigation trap: LocalHostGate used to
    // return `<>{children}</>` on bypass but `<HostCompatibilityGate>
    // {children}</HostCompatibilityGate>` when ready - different element
    // types at the same tree position, so React remounted every descendant
    // (including SystemTabModalHost) on every epic<->settings crossing. Both
    // branches must now share one element type/tree depth for a signed-in,
    // ready local host.
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const host = makeHost(validSnapshot);
    seedStoredToken(host);
    // Stable across rerenders: `HostRuntimeProvider` re-runs its startup
    // effect (tearing down and rebuilding the whole binding) whenever
    // `messengerFactory` / `remoteFetcher` change identity, which would mask
    // the very remount this test checks for.
    const messengerFactory = buildMessengerFactory(() => compatibleHostStatus);
    const remoteFetcher = () => Promise.resolve([]);
    const queryClient = buildQueryClient();

    const mountLog: string[] = [];
    function MountLogProbe(): ReactNode {
      useEffect(() => {
        mountLog.push("mounted");
        return () => {
          mountLog.push("unmounted");
        };
      }, []);
      return <div data-testid="gate-children">children</div>;
    }

    function Harness(props: { readonly bypass: boolean }): ReactNode {
      return (
        <RunnerHostProvider runnerHost={host}>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <HostRuntimeProvider
                registry={hostRpcRegistry}
                messengerFactory={messengerFactory}
                invalidator={null}
                requestId={null}
                remoteFetcher={remoteFetcher}
                fallback={
                  <div data-testid="runtime-fallback">runtime loading</div>
                }
              >
                <HostCompatibilityProvider>
                  <LocalHostGate
                    bypass={props.bypass}
                    selectedEntry={localEntry}
                    loading={<div data-testid="gate-loading">loading</div>}
                    provisioningLoading={null}
                    unavailable={
                      <div data-testid="gate-unavailable">unavailable</div>
                    }
                  >
                    <MountLogProbe />
                  </LocalHostGate>
                </HostCompatibilityProvider>
              </HostRuntimeProvider>
            </TooltipProvider>
          </QueryClientProvider>
        </RunnerHostProvider>
      );
    }

    const { rerender } = render(<Harness bypass={false} />);
    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
    expect(mountLog).toEqual(["mounted"]);

    rerender(<Harness bypass />);
    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
    expect(mountLog).toEqual(["mounted"]);

    rerender(<Harness bypass={false} />);
    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
    expect(mountLog).toEqual(["mounted"]);

    rerender(<Harness bypass />);
    await waitFor(() => {
      expect(screen.queryByTestId("gate-children")).not.toBeNull();
    });
    expect(mountLog).toEqual(["mounted"]);
  });
});

describe("LocalHostGate + system tab modal guard integration", () => {
  beforeEach(() => {
    restoreFetch = installAuthFetch();
    resetSystemTabModalColdLoadForTests();
    useSettingsSectionStore.setState({ section: null });
    useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.restoreAllMocks();
    restoreFetch();
    window.localStorage.clear();
  });

  it("one Back click after promoting the settings overlay leaves settings AND collapses the overlay entry", async () => {
    // Closes the gap the promotion regression test (which deliberately keeps
    // a REMOUNTING synthetic gate to isolate layers 2+3) leaves uncovered:
    // with the REAL fixed LocalHostGate (layer 1) driving `bypass`, back
    // click #1 from the promoted tab must both leave settings AND collapse
    // the stray overlay entry in one click - the pre-fix "no bug" behavior
    // the root-cause artifact's proof section describes for the
    // non-remounting case.
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const host = makeHost(validSnapshot);
    seedStoredToken(host);
    const messengerFactory = buildMessengerFactory(() => compatibleHostStatus);
    const remoteFetcher = () => Promise.resolve([]);
    const queryClient = buildQueryClient();

    const modalProbe: { current: SystemTabModalApi | null } = { current: null };
    function ModalHostLike(): ReactNode {
      useSystemTabModalRefreshGuard();
      const api = useSystemTabModalController();
      useEffect(() => {
        modalProbe.current = api;
      });
      return null;
    }

    function GuardedRootWithRealGate(): ReactNode {
      const pathname = useRouterState({ select: (s) => s.location.pathname });
      const bypass = pathname.startsWith(GATE_BYPASS_PATH_PREFIX);
      return (
        <LocalHostGate
          bypass={bypass}
          selectedEntry={localEntry}
          loading={<div data-testid="gate-loading">loading</div>}
          provisioningLoading={null}
          unavailable={<div data-testid="gate-unavailable">unavailable</div>}
        >
          <ModalHostLike />
          <Outlet />
        </LocalHostGate>
      );
    }

    const windowId = "real-gate-promote-back";
    window.localStorage.setItem(
      `traycer-gui-app:last-route:${windowId}`,
      JSON.stringify({ entries: ["/epics/e/t0", "/epics/e/t1"], index: 1 }),
    );

    const rootRoute = createRootRoute({
      validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
      component: GuardedRootWithRealGate,
    });
    const epicRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/epics/$epicId/$tabId",
      component: () => <div data-testid="epic-route" />,
    });
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/general",
      component: () => <div data-testid="settings-route" />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([epicRoute, settingsRoute]),
      history: createPersistentMemoryHistory(null, windowId),
    });

    render(
      <RunnerHostProvider runnerHost={host}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <HostRuntimeProvider
              registry={hostRpcRegistry}
              messengerFactory={messengerFactory}
              invalidator={null}
              requestId={null}
              remoteFetcher={remoteFetcher}
              fallback={
                <div data-testid="runtime-fallback">runtime loading</div>
              }
            >
              <HostCompatibilityProvider>
                <RouterProvider router={router} />
              </HostCompatibilityProvider>
            </HostRuntimeProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/epics/e/t1");
    });
    await waitFor(() => expect(modalProbe.current).not.toBeNull());

    act(() => {
      modalProbe.current?.openSettings({
        section: null,
        resetToGeneral: false,
      });
    });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        settingsOverlay: true,
      }),
    );

    act(() => {
      modalProbe.current?.close();
    });
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty(
        "settingsOverlay",
      ),
    );

    act(() => {
      goForward(router);
    });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        settingsOverlay: true,
      }),
    );

    act(() => {
      modalProbe.current?.promoteToTab();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    act(() => {
      goBack(router);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // One click: leaves settings AND the overlay entry is fully collapsed -
    // no lingering search flag, no dead forward/back step remains.
    expect(router.state.location.pathname).toBe("/epics/e/t1");
    expect(router.state.location.search).not.toHaveProperty("settingsOverlay");

    const controller = getHistoryController(router.history);
    if (controller === null) {
      throw new Error("expected a persistent controller");
    }
    expect(controller.getEntries()).toEqual([
      "/epics/e/t0",
      "/epics/e/t1",
      "/settings/general",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(controller.canGoBack()).toBe(true);
    expect(controller.canGoForward()).toBe(true);
  });
});

describe("<LocalHostUnavailable />", () => {
  afterEach(() => {
    cleanup();
  });

  it("invokes runnerHost.requestHostRespawn() when the Retry button is clicked", async () => {
    const host = makeHost(null);
    render(
      withQueryClient(
        <RunnerHostProvider runnerHost={host}>
          <LocalHostUnavailable message="Local host unavailable." />
        </RunnerHostProvider>,
      ),
    );

    const retry = await screen.findByTestId("local-host-retry");
    expect(host.requestHostRespawnCalls).toBe(0);
    fireEvent.click(retry);

    await waitFor(() => {
      expect(host.requestHostRespawnCalls).toBe(1);
    });
  });

  it("renders the supplied message inside the unavailable card", () => {
    const host = makeHost(null);
    render(
      withQueryClient(
        <RunnerHostProvider runnerHost={host}>
          <LocalHostUnavailable message="Custom unavailable copy." />
        </RunnerHostProvider>,
      ),
    );

    expect(screen.getByTestId("local-host-unavailable").textContent).toContain(
      "Custom unavailable copy.",
    );
  });
});
