import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { PendingEpicTitleFetcher } from "@/providers/pending-epic-title-fetcher";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { clearSessionCreatedEpics } from "@/lib/epics/session-created-epics";

/**
 * `PendingEpicTitleFetcher` bridges the gap left when an epic's tab is
 * swapped in without activation (see the provider's own header comment): no
 * session mounts, so nothing writes the generated title onto the tab until
 * the user opens it. These tests pin the bridge's three externally
 * observable behaviors: it renames the tab and clears the pending entry once
 * a non-empty title arrives, it keeps polling (the method's 2s fixed
 * cadence) until that title is non-empty, and it never calls the host method
 * at all when the host has not advertised `epic.getTaskContexts`.
 */

const EPIC_ID = "epic-pending-title";

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-title-fetcher",
  websocketUrl: "ws://127.0.0.1:4919/rpc",
  version: "1.2.3",
  pid: 4344,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
  availability: "available",
};

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;
type GetTaskContextsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "epic.getTaskContexts"
>;
type GetTaskContextsRequest = RequestOfMethod<
  HostRpcRegistry,
  "epic.getTaskContexts"
>;

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  updateOperation: null,
  updateTransaction: null,
  storeFormats: null,
  install: null,
};

/** A `getTaskContexts` "found" row shaped by `epicLightWithPermissionSchema`. */
function foundTaskLight(taskId: string, title: string) {
  return {
    epic: {
      light: {
        id: taskId,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt: 2,
        createdBy: "user-1",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

function foundRow(
  taskId: string,
  title: string,
): NonNullable<GetTaskContextsResponse["tasks"][string]> {
  return { status: "found", task: foundTaskLight(taskId, title) };
}

let restoreFetch: () => void = () => undefined;

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
        new Error(
          `unexpected fetch in pending-epic-title-fetcher test: ${url}`,
        ),
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

interface MountOptions {
  readonly getTaskContexts: (
    params: GetTaskContextsRequest,
  ) => Promise<GetTaskContextsResponse> | GetTaskContextsResponse;
}

function buildMessengerFactory(
  options: MountOptions,
): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${String(nextRequestId++)}`,
      handlers: {
        "host.status": () => compatibleHostStatus,
        "epic.getTaskContexts": (params) => options.getTaskContexts(params),
      },
    });
}

let nextRequestId = 1;

interface MountedFetcher {
  readonly queryClient: QueryClient;
}

function mountFetcher(options: MountOptions): MountedFetcher {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  void host.tokenStore.signIn(
    { token: "test-token", refreshToken: "test-refresh-token" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Test User",
      email: "test@example.com",
    },
    { userId: "test-user", username: "Test User" },
    [],
  );

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const messengerFactory = buildMessengerFactory(options);
  const remoteFetcher = () =>
    Promise.resolve({ kind: "hosts" as const, entries: [] });

  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={remoteFetcher}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <HostCompatibilityProvider>
            <PendingEpicTitleFetcher />
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  return { queryClient };
}

describe("PendingEpicTitleFetcher", () => {
  let tabId: string;

  beforeEach(() => {
    restoreFetch = installAuthFetch();
    tabId = useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "");
    useEpicCanvasStore.getState().markEpicTitlePending(EPIC_ID, "");
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.getState().closeTabsForEpics([EPIC_ID]);
    clearSessionCreatedEpics();
    resetNegotiatedManifests();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("renames the tab and clears the pending entry once a non-empty title arrives", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse => ({
        tasks: { [EPIC_ID]: foundRow(EPIC_ID, "Generated title") },
      }),
    );

    const { queryClient } = mountFetcher({ getTaskContexts });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().tabsById[tabId]?.name).toBe(
        "Generated title",
      );
    });
    expect(useEpicCanvasStore.getState().pendingEpicTitles[EPIC_ID]).toBe(
      undefined,
    );
    queryClient.clear();
  });

  it("keeps polling until the title lands", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    let call = 0;
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse => {
        call += 1;
        return {
          tasks: {
            [EPIC_ID]: foundRow(EPIC_ID, call === 1 ? "" : "Generated title"),
          },
        };
      },
    );

    const { queryClient } = mountFetcher({ getTaskContexts });

    await waitFor(
      () => {
        expect(useEpicCanvasStore.getState().tabsById[tabId]?.name).toBe(
          "Generated title",
        );
      },
      { timeout: 6000 },
    );
    expect(getTaskContexts.mock.calls.length).toBeGreaterThanOrEqual(2);
    queryClient.clear();
  });

  it("never calls the method when the host has not advertised it", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, ["host.status"]);
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse => ({
        tasks: {},
      }),
    );

    const { queryClient } = mountFetcher({ getTaskContexts });

    // Settle the runtime: host.status has to resolve before the probe's
    // other gates would have opened, so this waits past the point where an
    // ungated run would already have fired.
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "success"),
      ).toBe(true);
    });
    expect(getTaskContexts).not.toHaveBeenCalled();
    expect(useEpicCanvasStore.getState().tabsById[tabId]?.name).toBe("");
    queryClient.clear();
  });
});
