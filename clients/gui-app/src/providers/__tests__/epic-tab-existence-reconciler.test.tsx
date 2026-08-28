import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
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
  busyBreakdown: null,
  // `null` = this fixture's host did not report the durable attempt,
  // which is exactly what host.status@1.2-and-older peers send.
  updateOperation: null,
  updateTransaction: null,
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

interface MountedReconciler {
  readonly queryClient: QueryClient;
  /**
   * Mounts / unmounts ONLY the reconciler, keeping this window's host runtime
   * and query cache. A whole-tree remount would restart the runtime, and
   * `HostClient.setRequestContext` invalidates the entire `["host"]` scope on
   * every start - a deliberate credential fence, and not the shape a route
   * change produces.
   */
  readonly setReconcilerMounted: (mounted: boolean) => void;
}

function mountReconciler(options: MountOptions): MountedReconciler {
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
  // Hoisted so a `rerender` hands `HostRuntimeProvider` identical props and
  // therefore does not restart the runtime.
  const messengerFactory = buildMessengerFactory(options);
  const remoteFetcher = () =>
    Promise.resolve({ kind: "hosts" as const, entries: [] });
  const tree = (reconcilerMounted: boolean) => (
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
            {reconcilerMounted ? <EpicTabExistenceReconciler /> : null}
          </HostCompatibilityProvider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );
  const { rerender } = render(tree(true));
  return {
    queryClient,
    setReconcilerMounted: (mounted: boolean) => {
      rerender(tree(mounted));
    },
  };
}

/** Every cache key the reconciler's batch currently occupies. */
function reconcileQueryKeys(queryClient: QueryClient): ReadonlyArray<QueryKey> {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter((queryKey) => queryKey.includes("epic.getTaskContexts"));
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

    const { queryClient } = mountReconciler({ getTaskContexts });

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

    const { queryClient } = mountReconciler({ getTaskContexts });

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

    const { queryClient } = mountReconciler({ getTaskContexts });

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

    const { queryClient } = mountReconciler({ getTaskContexts });

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

  it("reuses the completed batch across a remount inside the stale window", async () => {
    // The churn this pins: the run used to suffix its cache key with a
    // process-global `attempt`, so every remount minted a brand-new key and
    // re-fanned the batch - one `POST /tasks/context` per open tab, per
    // remount, forever. Key stability alone is not enough either: with the
    // default zero stale time react-query refetches a remounted observer.
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse => ({
        tasks: {
          [OPEN_EPIC_ID]: { status: "unknown", reason: "transport" },
        },
      }),
    );

    const { queryClient, setReconcilerMounted } = mountReconciler({
      getTaskContexts,
    });
    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(reconcileQueryKeys(queryClient)).toHaveLength(1);
    });
    const keyAfterFirstRun = reconcileQueryKeys(queryClient)[0];
    const findRun = () =>
      queryClient.getQueryCache().find({ queryKey: keyAfterFirstRun });

    await act(async () => {
      setReconcilerMounted(false);
      await Promise.resolve();
    });
    expect(findRun()?.getObserversCount()).toBe(0);
    await act(async () => {
      setReconcilerMounted(true);
      await Promise.resolve();
    });
    // Re-attached to the same cache entry, so the remounted run got that far
    // and any refetch it would schedule has been scheduled.
    await waitFor(() => {
      expect(findRun()?.getObserversCount()).toBe(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getTaskContexts).toHaveBeenCalledTimes(1);
    expect(reconcileQueryKeys(queryClient)).toEqual([keyAfterFirstRun]);
    expect(collectOpenEpicIds()).toContain(OPEN_EPIC_ID);
    queryClient.clear();
  });

  it("keeps host, user and canvas-hydration identity inside the cache key", async () => {
    // Dropping `attempt` must not drop the SCOPE with it: a permission- and
    // host-dependent answer may never be reused across a host swap, an account
    // switch, or a canvas rehydration.
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
    ]);
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest): GetTaskContextsResponse =>
        UNKNOWN_TASK_CONTEXTS,
    );

    const { queryClient } = mountReconciler({ getTaskContexts });
    await waitFor(() => {
      expect(reconcileQueryKeys(queryClient)).toHaveLength(1);
    });

    const key = reconcileQueryKeys(queryClient)[0];
    expect(key.at(-1)).toBe(`${localSnapshot.hostId}:test-user:1`);
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

    const { queryClient } = mountReconciler({ getTaskContexts });

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
