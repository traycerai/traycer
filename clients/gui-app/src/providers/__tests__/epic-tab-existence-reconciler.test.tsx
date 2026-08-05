import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
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
import { EpicTabExistenceReconciler } from "@/providers/epic-tab-existence-reconciler";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  collectOpenEpicIds,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { clearSessionCreatedEpics } from "@/lib/epics/session-created-epics";

/**
 * The reconciler's only action is destructive: it force-closes epic tabs whose
 * epics it believes are gone. `epic.getTaskContexts` is an OPTIONAL (non-floor)
 * method, so a pre-1.1.7 host rejects it client-side with
 * `E_HOST_UNSUPPORTED`. Every test here pins the same invariant from a
 * different failure direction: absent evidence must close NOTHING.
 *
 * The happy path (a confirmed tab survives, an unconfirmed one is pruned) is
 * covered in host-compatibility-provider.test.tsx; these are its complements,
 * and they only discriminate because that test proves pruning does happen
 * under the same fixture shape.
 */

const OPEN_EPIC_ID = "epic-open-persisted";

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-reconciler",
  websocketUrl: "ws://127.0.0.1:4918/rpc",
  version: "1.2.3",
  pid: 4343,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
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
type ListTasksResponse = ResponseOfMethod<HostRpcRegistry, "epic.listTasks">;
type ListTasksRequest = RequestOfMethod<HostRpcRegistry, "epic.listTasks">;

const EMPTY_LIST_TASKS_RESPONSE: ListTasksResponse = {
  tasks: [],
  hasMore: false,
};

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
};

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
        new Error(`unexpected fetch in reconciler test: ${url}`),
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
  readonly listTasks?: (
    params: ListTasksRequest,
  ) => Promise<ListTasksResponse> | ListTasksResponse;
}

function buildMessengerFactory(
  options: MountOptions,
): MessengerFactory<HostRpcRegistry> {
  const listTasks = options.listTasks ?? (() => EMPTY_LIST_TASKS_RESPONSE);
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${String(nextRequestId++)}`,
      handlers: {
        "host.status": () => compatibleHostStatus,
        "epic.getTaskContexts": (params) => options.getTaskContexts(params),
        "epic.listTasks": (params) => listTasks(params),
      },
    });
}

let nextRequestId = 1;

function mountReconciler(options: MountOptions): QueryClient {
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
  useEpicCanvasStore.getState().openEpicTab(OPEN_EPIC_ID, "Open Epic");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={buildMessengerFactory(options)}
          invalidator={null}
          requestId={null}
          remoteFetcher={() =>
            Promise.resolve({ kind: "hosts" as const, entries: [] })
          }
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <HostCompatibilityProvider>
            <EpicTabExistenceReconciler />
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return queryClient;
}

function unsupportedError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "This host does not support 'epic.getTaskContexts'.",
    requestId: "req-unsupported",
    method: "epic.getTaskContexts",
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason: "This host does not support 'epic.getTaskContexts'.",
      incompatibleMethods: null,
      upgradeGuidance: { clientShouldUpgrade: false, hostShouldUpgrade: true },
    },
  });
}

describe("EpicTabExistenceReconciler fail-closed paths", () => {
  beforeEach(() => {
    restoreFetch = installAuthFetch();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.installSourceReconciliation();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.getState().closeTabsForEpics([OPEN_EPIC_ID]);
    useInitialChatHandoffStore.getState().resetForTests();
    clearSessionCreatedEpics();
    resetNegotiatedManifests();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("never calls the method when the host has not advertised it", async () => {
    // A host that completed a handshake WITHOUT epic.getTaskContexts: known
    // absent, not merely unknown. Reconciliation must not run at all.
    recordNegotiatedHostMethods(localSnapshot.hostId, ["host.status"]);
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse => ({
        tasks: {},
      }),
    );

    const queryClient = mountReconciler({ getTaskContexts });

    // Settle the runtime: host.status has to resolve before the reconciler's
    // other gates would have opened, so this waits past the point where an
    // ungated run would have fired.
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "success"),
      ).toBe(true);
    });
    expect(getTaskContexts).not.toHaveBeenCalled();
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
    queryClient.clear();
  });

  it("closes no tabs when the method is unsupported at call time", async () => {
    // The manifest advertised it (so the run starts) but the call rejects with
    // E_HOST_UNSUPPORTED - the shape a host downgraded between handshake and
    // call produces. An empty-map degrade here would prune every open tab.
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    const getTaskContexts = vi.fn((_params: GetTaskContextsRequest) => {
      throw unsupportedError();
    });

    const queryClient = mountReconciler({ getTaskContexts });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "error"),
      ).toBe(true);
    });
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
    queryClient.clear();
  });

  it("closes no tabs when the lookup fails for an ordinary transport reason", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    const getTaskContexts = vi.fn((_params: GetTaskContextsRequest) => {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "connection reset",
        requestId: "req-boom",
        method: "epic.getTaskContexts",
        fatalDetails: null,
      });
    });

    const queryClient = mountReconciler({ getTaskContexts });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "error"),
      ).toBe(true);
    });
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
    queryClient.clear();
  });

  it("closes no tabs while the lookup is still in flight", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    let resolveLookup: (value: GetTaskContextsResponse) => void = () => {
      throw new Error("deferred resolver was not initialized");
    };
    const pending = new Promise<GetTaskContextsResponse>((resolve) => {
      resolveLookup = resolve;
    });
    const getTaskContexts = vi.fn((_params: GetTaskContextsRequest) => pending);

    const queryClient = mountReconciler({ getTaskContexts });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);

    // Resolving with the id unconfirmed prunes it - the same fixture that had
    // to leave the tab open while pending. Without this the test would pass
    // even if the reconciler never concluded anything at all.
    act(() => {
      resolveLookup({ tasks: { [OPEN_EPIC_ID]: null } });
    });
    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(OPEN_EPIC_ID);
    });
    queryClient.clear();
  });
});

/**
 * Durability proof for the local-homed protection path. `mountReconciler`
 * mounts a fresh reconciler with none of the session-scoped exemptions
 * (`wasEpicCreatedThisSession`, the open-epic registry, an active initial-chat
 * handoff) ever populated for this epic - the same state a cold app relaunch
 * starts from. If the tab survives here, survival can only be attributed to
 * the durable `home: "local"` marker on the host-merged `epic.listTasks` row,
 * not to a session marker that a relaunch would have already cleared.
 */
const LOCAL_HOME_EPIC_ID = "epic-local-homed-across-relaunch";

function localHomedListTasksRow(
  epicId: string,
): ListTasksResponse["tasks"][number] {
  return {
    epic: {
      light: {
        id: epicId,
        title: "Local-only epic",
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
    pinned: false,
    home: "local",
  };
}

describe("EpicTabExistenceReconciler local-homed durable protection", () => {
  beforeEach(() => {
    restoreFetch = installAuthFetch();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.installSourceReconciliation();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore
      .getState()
      .closeTabsForEpics([OPEN_EPIC_ID, LOCAL_HOME_EPIC_ID]);
    useInitialChatHandoffStore.getState().resetForTests();
    clearSessionCreatedEpics();
    resetNegotiatedManifests();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("keeps a local-homed epic's tab open even when getTaskContexts reports it missing, with no session-scoped exemption in play", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    // Open a second tab for the local-homed epic before mounting - mirrors a
    // persisted tab restored at app start, before any session state (created-
    // this-session marker, open-epic registry entry, initial-chat handoff)
    // could exist for it.
    useEpicCanvasStore.getState().openEpicTab(LOCAL_HOME_EPIC_ID, "Local Epic");

    const getTaskContexts = vi.fn(
      (params: GetTaskContextsRequest): GetTaskContextsResponse => {
        const tasks: GetTaskContextsResponse["tasks"] = {};
        for (const taskId of params.taskIds) {
          // The cloud has no record of this local-only epic; every other
          // open id (OPEN_EPIC_ID) resolves confirmed so the test isolates
          // the local-homed exemption rather than the "missing" default.
          tasks[taskId] =
            taskId === LOCAL_HOME_EPIC_ID
              ? null
              : {
                  epic: {
                    light: {
                      id: taskId,
                      title: "Confirmed",
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
        return { tasks };
      },
    );

    const listTasks = vi.fn((_params: ListTasksRequest): ListTasksResponse => ({
      tasks: [localHomedListTasksRow(LOCAL_HOME_EPIC_ID)],
      hasMore: false,
    }));

    const queryClient = mountReconciler({ getTaskContexts, listTasks });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(listTasks).toHaveBeenCalledTimes(1);
    });

    // Give the reconciliation effect a tick to run to completion (or to
    // wrongly close the tab) before asserting the durable outcome.
    await waitFor(() => {
      expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
    });
    expect(collectOpenEpicIds()).toContain(LOCAL_HOME_EPIC_ID);
    queryClient.clear();
  });
});
