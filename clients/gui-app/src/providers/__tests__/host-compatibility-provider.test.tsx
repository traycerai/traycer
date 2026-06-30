import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  useHostCompatibility,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { EpicTabExistenceReconciler } from "@/providers/epic-tab-existence-reconciler";
import { HarnessCatalogPrefetcher } from "@/providers/harness-catalog-prefetcher";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

const STARTUP_EPIC_ID = "epic-startup-compat";

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;
type ListTasksResponse = ResponseOfMethod<HostRpcRegistry, "epic.listTasks">;
type ListHarnessesResponse = ResponseOfMethod<
  HostRpcRegistry,
  "agent.gui.listHarnesses"
>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface StartupConsumersOptions {
  readonly hostStatus: () => Promise<HostStatusResponse> | HostStatusResponse;
  readonly listTasks: () => ListTasksResponse;
  readonly listHarnesses: () => ListHarnessesResponse;
  readonly onMethod: (method: string) => void;
}

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
};

let restoreFetch: () => void = () => undefined;

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => {
    throw new Error("deferred resolver was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function buildMessengerFactory(
  options: StartupConsumersOptions,
): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "host.status": () => {
          options.onMethod("host.status");
          return options.hostStatus();
        },
        "epic.listTasks": () => {
          options.onMethod("epic.listTasks");
          return options.listTasks();
        },
        "agent.gui.listHarnesses": () => {
          options.onMethod("agent.gui.listHarnesses");
          return options.listHarnesses();
        },
      },
    });
}

function mountStartupConsumers(options: StartupConsumersOptions): QueryClient {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  void host.tokenStore.set({
    token: "test-token",
    refreshToken: "test-refresh-token",
  });
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Test User",
      email: "test@example.com",
    },
    { userId: "test-user", username: "Test User" },
    [],
  );
  useEpicCanvasStore.getState().openEpicTab(STARTUP_EPIC_ID, "Startup Compat");

  const queryClient = buildQueryClient();
  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={buildMessengerFactory(options)}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve([])}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <HostCompatibilityProvider>
            <CompatibilityStatusProbe />
            <EpicTabExistenceReconciler />
            <HarnessCatalogPrefetcher />
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return queryClient;
}

function CompatibilityStatusProbe(): ReactNode {
  const compatibility = useHostCompatibility();
  return <div data-testid="compat-status">{compatibility.status}</div>;
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
                id: "test-user",
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
                userID: "test-user",
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
        new Error(`unexpected fetch in host compatibility test: ${url}`),
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

describe("HostCompatibilityProvider startup consumers", () => {
  beforeEach(() => {
    restoreFetch = installAuthFetch();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.getState().closeTabsForEpics([STARTUP_EPIC_ID]);
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("holds startup host RPC consumers until host.status succeeds", async () => {
    const hostStatus = createDeferred<HostStatusResponse>();
    const methods: string[] = [];
    const listTasks = vi.fn((): ListTasksResponse => ({
      tasks: [],
      hasMore: false,
    }));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const queryClient = mountStartupConsumers({
      hostStatus: () => hostStatus.promise,
      listTasks,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });

    await waitFor(() => {
      expect(methods).toEqual(["host.status"]);
    });
    expect(listTasks).not.toHaveBeenCalled();
    expect(listHarnesses).not.toHaveBeenCalled();
    expect(screen.getByTestId("compat-status").textContent).toBe("checking");

    act(() => {
      hostStatus.resolve(compatibleHostStatus);
    });

    await waitFor(() => {
      expect(listTasks).toHaveBeenCalledTimes(1);
      expect(listHarnesses).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("compat-status").textContent).toBe("compatible");
    expect(methods[0]).toBe("host.status");
    expect(methods).toEqual(
      expect.arrayContaining([
        "host.status",
        "epic.listTasks",
        "agent.gui.listHarnesses",
      ]),
    );
    queryClient.clear();
  });

  it("does not start startup host RPC consumers after an incompatible status verdict", async () => {
    const methods: string[] = [];
    const listTasks = vi.fn((): ListTasksResponse => ({
      tasks: [],
      hasMore: false,
    }));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const queryClient = mountStartupConsumers({
      hostStatus: () => {
        throw new HostRpcError({
          code: "INCOMPATIBLE",
          message: "Incompatible methods: epic.listTasks",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      listTasks,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("compat-status").textContent).toBe(
        "incompatible",
      );
    });
    expect(methods).toEqual(["host.status"]);
    expect(listTasks).not.toHaveBeenCalled();
    expect(listHarnesses).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
