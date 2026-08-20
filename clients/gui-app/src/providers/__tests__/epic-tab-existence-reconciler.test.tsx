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
type ListTasksResponse = ResponseOfMethod<HostRpcRegistry, "epic.listTasks">;
type ListTasksRequest = RequestOfMethod<HostRpcRegistry, "epic.listTasks">;

const EMPTY_LIST_TASKS_RESPONSE: ListTasksResponse = {
  tasks: [],
  hasMore: false,
};

const UNKNOWN_TASK_CONTEXTS: GetTaskContextsResponse = {
  tasks: {
    [OPEN_EPIC_ID]: { status: "unknown", reason: "transport" },
  },
};

// A v1.0 host's nullable row is upgraded at the transport boundary before the
// reconciler sees it. The protocol schema suite covers that upgrade itself.
const LEGACY_TASK_CONTEXTS: GetTaskContextsResponse = {
  tasks: {
    [OPEN_EPIC_ID]: { status: "unknown", reason: "legacy" },
  },
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

  it("closes only after the lookup confirms the epic is absent", async () => {
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

    // A successful batch with an explicit confirmed-absent row is the only
    // result that may prune the tab. Without this assertion the test could
    // pass even if the reconciler never concluded anything at all.
    act(() => {
      resolveLookup({
        tasks: { [OPEN_EPIC_ID]: { status: "confirmed-absent" } },
      });
    });
    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(OPEN_EPIC_ID);
    });
    queryClient.clear();
  });

  it.each([
    {
      label: "an explicit unknown row",
      response: UNKNOWN_TASK_CONTEXTS,
    },
    {
      label: "a legacy host row upgraded to unknown",
      response: LEGACY_TASK_CONTEXTS,
    },
  ])("closes no tabs for $label", async ({ response }) => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse => response,
    );

    const queryClient = mountReconciler({ getTaskContexts });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "success"),
      ).toBe(true);
    });
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
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
/**
 * A genuinely-stale persisted tab: absent from `getTaskContexts`, absent from
 * the list page, and carrying no session-scoped exemption. Its CLOSURE is what
 * proves reconciliation actually ran, which the local-home assertion below
 * needs and cannot establish for itself - `OPEN_EPIC_ID` is open before the
 * reconciler mounts, so waiting for it passes on the first tick either way.
 */
const STALE_EPIC_ID = "epic-stale-persisted";

/** A LISTED row with no `home` marker - a cloud-homed epic, which is what a
 * promotion that lands between the two reconciliation RPCs produces. */
function cloudHomedListTasksRow(
  epicId: string,
): ListTasksResponse["tasks"][number] {
  const { home: _home, ...row } = localHomedListTasksRow(epicId);
  return row;
}

/** A `getTaskContexts` row the host POSITIVELY confirmed. */
function confirmedRow(
  taskId: string,
): NonNullable<GetTaskContextsResponse["tasks"][string]> {
  return {
    status: "found",
    task: confirmedTaskLight(taskId),
  };
}

function confirmedTaskLight(taskId: string) {
  return {
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
      .closeTabsForEpics([OPEN_EPIC_ID, LOCAL_HOME_EPIC_ID, STALE_EPIC_ID]);
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
    useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale Epic");

    const getTaskContexts = vi.fn(
      (params: GetTaskContextsRequest): GetTaskContextsResponse => {
        const tasks: GetTaskContextsResponse["tasks"] = {};
        for (const taskId of params.taskIds) {
          // The cloud has no record of this local-only epic; every other
          // open id (OPEN_EPIC_ID) resolves confirmed so the test isolates
          // the local-homed exemption rather than the "missing" default.
          tasks[taskId] =
            taskId === LOCAL_HOME_EPIC_ID || taskId === STALE_EPIC_ID
              ? { status: "confirmed-absent" as const }
              : confirmedRow(taskId);
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

    // Wait on the reconciler's own OUTPUT - the stale tab closing - so the
    // local-home assertion below runs against a completed sweep. Waiting for
    // `OPEN_EPIC_ID` instead was vacuous: that tab is open before the
    // reconciler mounts, so the condition held before it had done anything.
    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    expect(collectOpenEpicIds()).toContain(LOCAL_HOME_EPIC_ID);
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
    queryClient.clear();
  });

  it("keeps a tab open when the host leaves its id UNANSWERED, closing only ids answered null", async () => {
    // An id absent from a successful `getTaskContexts` response is the
    // resolver's INDETERMINATE encoding - "this host could not classify it"
    // (an unreadable home record, or a store that exists on disk but could
    // not open). It is a distinct wire fact from `null` ("deleted"), and
    // reading the two identically force-closed every local tab whenever the
    // store was unavailable at relaunch.
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    useEpicCanvasStore
      .getState()
      .openEpicTab(LOCAL_HOME_EPIC_ID, "Unclassified");
    useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale Epic");

    const getTaskContexts = vi.fn(
      (params: GetTaskContextsRequest): GetTaskContextsResponse => {
        const tasks: GetTaskContextsResponse["tasks"] = {};
        for (const taskId of params.taskIds) {
          // LOCAL_HOME_EPIC_ID is deliberately ABSENT from the answer;
          // STALE_EPIC_ID is answered null (positively deleted).
          if (taskId === LOCAL_HOME_EPIC_ID) continue;
          tasks[taskId] =
            taskId === STALE_EPIC_ID
              ? { status: "confirmed-absent" as const }
              : confirmedRow(taskId);
        }
        return { tasks };
      },
    );
    const listTasks = vi.fn((_params: ListTasksRequest): ListTasksResponse => ({
      tasks: [],
      hasMore: false,
    }));

    const queryClient = mountReconciler({ getTaskContexts, listTasks });

    // The stale tab's closure proves the sweep completed...
    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    // ...and the unanswered id survived it.
    expect(collectOpenEpicIds()).toContain(LOCAL_HOME_EPIC_ID);
    queryClient.clear();
  });

  it("declines destructive reconciliation when the local-rows page reports truncation", async () => {
    // With more local-homed epics than the first-page injection cap, the
    // 100-row list page does not carry every local epic - so the force-close
    // exemption set is provably incomplete and nothing destructive may rest
    // on it.
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Maybe Stale");

    const getTaskContexts = vi.fn(
      (params: GetTaskContextsRequest): GetTaskContextsResponse => {
        const tasks: GetTaskContextsResponse["tasks"] = {};
        for (const taskId of params.taskIds) {
          tasks[taskId] =
            taskId === STALE_EPIC_ID
              ? { status: "confirmed-absent" as const }
              : confirmedRow(taskId);
        }
        return { tasks };
      },
    );
    const listTasks = vi.fn((_params: ListTasksRequest): ListTasksResponse => ({
      tasks: [],
      hasMore: false,
      completeness: {
        cloudPage: "settled",
        facets: "server",
        localRows: "truncated",
        sort: "loaded-union",
      },
    }));

    const queryClient = mountReconciler({ getTaskContexts, listTasks });
    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(listTasks).toHaveBeenCalledTimes(1);
    });
    // Give the apply effect a settled pass, then assert nothing closed - the
    // truncated exemption set refuses the destructive step entirely.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(collectOpenEpicIds()).toContain(STALE_EPIC_ID);
    queryClient.clear();
  });

  it("keeps an epic the host could not classify open, so a promotion racing the reconcile cannot force-close it", async () => {
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    useEpicCanvasStore.getState().openEpicTab(LOCAL_HOME_EPIC_ID, "Promoted");
    useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale Epic");

    // The race this closes: `getTaskContexts` answered from BEFORE the
    // promotion, when the cloud side it consults has no row yet. The honest
    // wire answer there is the explicit `unknown` resolution arm - never
    // `confirmed-absent`, which is reserved for a positively-known deletion -
    // and only a positive absence may force-close. The `listTasks` page from
    // after the promotion carries the row cloud-homed (no `home` marker), so
    // the durable exemption set rightly does not include it either.
    const getTaskContexts = vi.fn(
      (params: GetTaskContextsRequest): GetTaskContextsResponse => {
        const tasks: GetTaskContextsResponse["tasks"] = {};
        for (const taskId of params.taskIds) {
          if (taskId === LOCAL_HOME_EPIC_ID) {
            tasks[taskId] = {
              status: "unknown" as const,
              reason: "not-found-or-not-permitted" as const,
            };
            continue;
          }
          tasks[taskId] =
            taskId === STALE_EPIC_ID
              ? { status: "confirmed-absent" as const }
              : confirmedRow(taskId);
        }
        return { tasks };
      },
    );
    const listTasks = vi.fn((_params: ListTasksRequest): ListTasksResponse => ({
      tasks: [cloudHomedListTasksRow(LOCAL_HOME_EPIC_ID)],
      hasMore: false,
    }));

    const queryClient = mountReconciler({ getTaskContexts, listTasks });

    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    expect(collectOpenEpicIds()).toContain(LOCAL_HOME_EPIC_ID);
    queryClient.clear();
  });
});
