import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
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
  useHostCompatibility,
  type HostCompatibility,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { EpicTabExistenceReconciler } from "@/providers/epic-tab-existence-reconciler";
import { HarnessCatalogPrefetcher } from "@/providers/harness-catalog-prefetcher";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  collectOpenEpicIds,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import {
  clearSessionCreatedEpics,
  markEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

const STARTUP_EPIC_ID = "epic-startup-compat";
const STALE_EPIC_ID = "epic-stale-persisted";
const FRESH_EPIC_ID = "epic-fresh-created";
const RESTORED_PHASE_ID = "phase-restored-persisted";
const RESTORED_PHASE_TAB_ID = "phase-restored-tab";

const HANDOFF_SETTINGS = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
} satisfies ChatRunSettings;

function registerActiveHandoff(epicId: string): void {
  useInitialChatHandoffStore.getState().register({
    hostId: localSnapshot.hostId,
    userId: "test-user",
    epicId,
    chatId: `${epicId}-chat`,
    content: { type: "doc", content: [] } satisfies JsonContent,
    settings: HANDOFF_SETTINGS,
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    messageId: `${epicId}-msg`,
    clientActionId: `${epicId}-cai`,
    createdAt: 1,
  });
}

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
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
type TaskContextRow = GetTaskContextsResponse["tasks"][string];
type ListHarnessesResponse = ResponseOfMethod<
  HostRpcRegistry,
  "agent.gui.listHarnesses"
>;
type ListTasksResponse = ResponseOfMethod<HostRpcRegistry, "epic.listTasks">;
type ListTasksRequest = RequestOfMethod<HostRpcRegistry, "epic.listTasks">;

const EMPTY_LIST_TASKS_RESPONSE: ListTasksResponse = {
  tasks: [],
  hasMore: false,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface StartupConsumersOptions {
  readonly hostStatus: () => Promise<HostStatusResponse> | HostStatusResponse;
  readonly getTaskContexts: (
    params: GetTaskContextsRequest,
  ) => Promise<GetTaskContextsResponse> | GetTaskContextsResponse;
  readonly listHarnesses: () =>
    Promise<ListHarnessesResponse> | ListHarnessesResponse;
  readonly listTasks?: (
    params: ListTasksRequest,
  ) => Promise<ListTasksResponse> | ListTasksResponse;
  readonly onMethod: (method: string) => void;
}

interface StartupConsumersMount {
  readonly queryClient: QueryClient;
  readonly host: MockRunnerHost;
}

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
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
  const listTasks = options.listTasks ?? (() => EMPTY_LIST_TASKS_RESPONSE);
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "host.status": () => {
          options.onMethod("host.status");
          return options.hostStatus();
        },
        "epic.getTaskContexts": (params) => {
          options.onMethod("epic.getTaskContexts");
          return options.getTaskContexts(params);
        },
        "agent.gui.listHarnesses": () => {
          options.onMethod("agent.gui.listHarnesses");
          return options.listHarnesses();
        },
        "epic.listTasks": (params) => {
          options.onMethod("epic.listTasks");
          return listTasks(params);
        },
      },
    });
}

function mountStartupConsumers(
  options: StartupConsumersOptions,
): StartupConsumersMount {
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
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
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
  return { queryClient, host };
}

function CompatibilityStatusProbe(): ReactNode {
  const compatibility = useHostCompatibility();
  return (
    <>
      <div role="status" aria-label="Host compatibility status">
        {compatibility.status}
      </div>
      <div role="status" aria-label="Host compatibility detail">
        {compatibilityDetail(compatibility)}
      </div>
      <div role="status" aria-label="Host status snapshot">
        {hostStatusDetail(compatibility)}
      </div>
    </>
  );
}

/**
 * The two flags a status alone cannot carry: whether a `compatible` verdict is
 * being HELD through a failed refetch, and whether a `failed` probe ever
 * reached the host at all.
 */
function compatibilityDetail(compatibility: HostCompatibility): string {
  if (compatibility.status === "compatible") {
    return compatibility.degraded ? "degraded" : "live";
  }
  if (compatibility.status === "failed") {
    return compatibility.unreachable ? "unreachable" : "rejected";
  }
  return "n/a";
}

/**
 * Surfaces the host.status payload fields carried on a `compatible` verdict
 * (busy / busySessionCount / hostVersion). Non-compatible arms never hold one.
 */
function hostStatusDetail(compatibility: HostCompatibility): string {
  if (compatibility.status !== "compatible") return "none";
  const snapshot = compatibility.hostStatus;
  return `busy=${String(snapshot.busy)};count=${String(snapshot.busySessionCount)};version=${snapshot.hostVersion}`;
}

function getCompatibilityStatusText(): string | null {
  return screen.getByRole("status", {
    name: "Host compatibility status",
  }).textContent;
}

function getCompatibilityDetailText(): string | null {
  return screen.getByRole("status", {
    name: "Host compatibility detail",
  }).textContent;
}

function getHostStatusSnapshotText(): string | null {
  return screen.getByRole("status", {
    name: "Host status snapshot",
  }).textContent;
}

function epicTask(epicId: string): TaskContextRow {
  return {
    epic: {
      light: {
        id: epicId,
        title: epicId,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "test",
        version: "2.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

// Resolves every requested id, confirming only `confirmedEpicIds` and
// returning `null` (deleted / not permitted - indistinguishable by design) for
// the rest. Mirrors the host contract: the response is keyed by the requested
// task ids, so a caller learns nothing about ids it did not ask about.
function taskContextsFor(
  confirmedEpicIds: ReadonlyArray<string>,
): (params: GetTaskContextsRequest) => GetTaskContextsResponse {
  const confirmed = new Set(confirmedEpicIds);
  return (params) => ({
    tasks: Object.fromEntries(
      params.taskIds.map((taskId): readonly [string, TaskContextRow] => [
        taskId,
        confirmed.has(taskId) ? epicTask(taskId) : null,
      ]),
    ),
  });
}

// Shared harness for the "freshly-created epic survives reconciliation" tests.
// The host confirms only the pre-existing startup tab, so a just-created epic
// (absent from cloud reads while they lag epic.create) is pruned unless a
// protection guard exempts it.
function mountReconcilerHarness(): { readonly queryClient: QueryClient } {
  const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
  const listHarnesses = vi.fn((): ListHarnessesResponse => ({
    harnesses: [],
  }));
  const { queryClient } = mountStartupConsumers({
    hostStatus: () => compatibleHostStatus,
    getTaskContexts,
    listHarnesses,
    onMethod: () => undefined,
  });
  return { queryClient };
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
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    // `EpicTabExistenceReconciler` now closes stale epics through
    // `tabCommandCoordinator.handleEpicAccessLoss`, which derives its
    // affected refs from the coordinator's OWN layout (`useTabsStore`), not
    // from the canvas store directly. Install the real source-reconciliation
    // subscription so every `openEpicTab*` call this file makes below is
    // reflected into that layout exactly as it is in the running app,
    // instead of hand-mirroring each auto-generated tab id into a second
    // fixture.
    tabCommandCoordinator.installSourceReconciliation();
    // `EpicTabExistenceReconciler` gates on the OPTIONAL (non-floor)
    // `epic.getTaskContexts` being advertised by this host. The real transport
    // records that from every `openAck`; `MockHostMessenger` has no handshake,
    // so the manifest is seeded here - without it the reconciler correctly
    // refuses to run and every prune assertion below would pass vacuously.
    recordNegotiatedHostMethods(localSnapshot.hostId, [
      "host.status",
      "epic.getTaskContexts",
      "agent.gui.listHarnesses",
    ]);
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore
      .getState()
      .closeTabsForEpics([
        STARTUP_EPIC_ID,
        STALE_EPIC_ID,
        FRESH_EPIC_ID,
        RESTORED_PHASE_ID,
      ]);
    useInitialChatHandoffStore.getState().resetForTests();
    clearSessionCreatedEpics();
    resetNegotiatedManifests();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("holds startup host RPC consumers until host.status succeeds", async () => {
    const hostStatus = createDeferred<HostStatusResponse>();
    const methods: string[] = [];
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => hostStatus.promise,
      getTaskContexts,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });

    await waitFor(() => {
      expect(methods).toEqual(["host.status"]);
    });
    expect(getTaskContexts).not.toHaveBeenCalled();
    expect(listHarnesses).not.toHaveBeenCalled();
    expect(getCompatibilityStatusText()).toBe("checking");

    act(() => {
      hostStatus.resolve(compatibleHostStatus);
    });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
      expect(listHarnesses).toHaveBeenCalledTimes(1);
    });
    // One id-scoped batch for the single open tab - not a paginated sweep.
    expect(getTaskContexts.mock.calls[0][0].taskIds).toEqual([STARTUP_EPIC_ID]);
    expect(getCompatibilityStatusText()).toBe("compatible");
    expect(methods[0]).toBe("host.status");
    expect(methods).toEqual(
      expect.arrayContaining([
        "host.status",
        "epic.getTaskContexts",
        "agent.gui.listHarnesses",
      ]),
    );
    queryClient.clear();
  });

  it("does not start startup host RPC consumers after an incompatible status verdict", async () => {
    const methods: string[] = [];
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        throw new HostRpcError({
          code: "INCOMPATIBLE",
          message: "Incompatible methods: epic.listTasks",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("incompatible");
    });
    expect(methods).toEqual(["host.status"]);
    expect(getTaskContexts).not.toHaveBeenCalled();
    expect(listHarnesses).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("surfaces exhausted non-terminal status probe failures without starting startup consumers", async () => {
    const methods: string[] = [];
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "status probe failed",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("failed");
    });
    // The host ANSWERED and the answer was an error, so this is a rejection,
    // not an unreachable host - the surface may say "compatibility" here.
    expect(getCompatibilityDetailText()).toBe("rejected");
    expect(methods).toEqual(["host.status", "host.status", "host.status"]);
    expect(getTaskContexts).not.toHaveBeenCalled();
    expect(listHarnesses).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("reports a first-probe transport failure as unreachable, not as a compatibility verdict", async () => {
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        throw new RetryableTransportError({
          code: "RPC_ERROR",
          message: "fetch failed",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: () => undefined,
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("failed");
    });
    expect(getCompatibilityDetailText()).toBe("unreachable");
    queryClient.clear();
  });

  // traycer#860: the host was alive and completing agent turns for the whole
  // session. A stream availability recovery invalidated the host-scoped
  // queries, the compat refetch failed under machine load, and the gate tore
  // the entire workspace down and told the user the host had not started.
  it("holds a compatible verdict when a later host.status refetch fails", async () => {
    let probes = 0;
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        probes += 1;
        if (probes === 1) return compatibleHostStatus;
        throw new RetryableTransportError({
          code: "RPC_ERROR",
          message: "host did not answer the dial",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: () => undefined,
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });
    expect(getCompatibilityDetailText()).toBe("live");

    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => {
      expect(getCompatibilityDetailText()).toBe("degraded");
    });
    // The verdict - and therefore every mounted host-backed surface - survives.
    expect(getCompatibilityStatusText()).toBe("compatible");
    expect(probes).toBeGreaterThan(1);
    queryClient.clear();
  });

  // traycer#4747: a successful host.status answer surfaces its own busy /
  // version payload on the compatible arm so report health can name a host
  // that was up and serving turns.
  it("carries hostStatus fields from a successful host.status answer", async () => {
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const busyStatus: HostStatusResponse = {
      ...compatibleHostStatus,
      busy: true,
      busySessionCount: 2,
      hostVersion: "9.9.9",
    };
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => busyStatus,
      getTaskContexts,
      listHarnesses,
      onMethod: () => undefined,
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });
    expect(getCompatibilityDetailText()).toBe("live");
    expect(getHostStatusSnapshotText()).toBe("busy=true;count=2;version=9.9.9");
    queryClient.clear();
  });

  // Held-verdict-after-failed-refetch must keep the last successful hostStatus
  // snapshot (data still present + isError) so a degraded connection still
  // reports the host that answered, not a blank startup.
  it("holds the last hostStatus when a later host.status refetch fails", async () => {
    let probes = 0;
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const firstAnswer: HostStatusResponse = {
      ...compatibleHostStatus,
      busy: true,
      busySessionCount: 4,
      hostVersion: "held-version",
    };
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        probes += 1;
        if (probes === 1) return firstAnswer;
        throw new RetryableTransportError({
          code: "RPC_ERROR",
          message: "host did not answer the dial",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: () => undefined,
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });
    expect(getHostStatusSnapshotText()).toBe(
      "busy=true;count=4;version=held-version",
    );

    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => {
      expect(getCompatibilityDetailText()).toBe("degraded");
    });
    expect(getCompatibilityStatusText()).toBe("compatible");
    // The held snapshot is the first successful answer, not a blank one.
    expect(getHostStatusSnapshotText()).toBe(
      "busy=true;count=4;version=held-version",
    );
    expect(probes).toBeGreaterThan(1);
    queryClient.clear();
  });

  it("still reports a genuine incompatible verdict that arrives after a compatible one", async () => {
    let probes = 0;
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        probes += 1;
        if (probes === 1) return compatibleHostStatus;
        throw new HostRpcError({
          code: "INCOMPATIBLE",
          message: "Incompatible methods: epic.listTasks",
          requestId: "req-status",
          method: "host.status",
          fatalDetails: null,
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: () => undefined,
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });

    await act(async () => {
      await queryClient.invalidateQueries();
    });

    // Holding a prior verdict must never swallow a real one: a host that was
    // replaced or updated under the same id says INCOMPATIBLE, and that wins.
    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("incompatible");
    });
    queryClient.clear();
  });

  it("asks only about the open epic tabs and prunes the ids the host does not confirm", async () => {
    const methods: string[] = [];
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => compatibleHostStatus,
      getTaskContexts,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });
    act(() => {
      useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale");
    });

    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    // The confirmed tab survives, and the host was asked about exactly the
    // open ids - never about the rest of the account's epic history.
    expect(collectOpenEpicIds()).toContain(STARTUP_EPIC_ID);
    expect(getTaskContexts).toHaveBeenCalledTimes(1);
    expect([...getTaskContexts.mock.calls[0][0].taskIds].sort()).toEqual(
      [STALE_EPIC_ID, STARTUP_EPIC_ID].sort(),
    );
    expect(methods[0]).toBe("host.status");
    queryClient.clear();
  });

  it("keeps a freshly-created epic tab unconfirmed by the host but protected by an active initial-chat handoff", async () => {
    const { queryClient } = mountReconcilerHarness();

    // FRESH_EPIC_ID models a just-created epic: unconfirmed by the host
    // (cloud reads lag epic.create) but carrying an active initial-chat
    // handoff. STALE_EPIC_ID is a genuinely-stale persisted tab with no
    // protection. Both are opened before the reconciler run captures
    // openEpicIds (host.status resolves on a later microtask, so this
    // synchronous block wins).
    act(() => {
      useEpicCanvasStore.getState().openEpicTab(FRESH_EPIC_ID, "Fresh");
      useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale");
      registerActiveHandoff(FRESH_EPIC_ID);
    });

    // The unprotected stale tab is pruned - proof reconciliation ran to
    // completion - while the handoff-protected fresh tab survives.
    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    expect(collectOpenEpicIds()).toContain(FRESH_EPIC_ID);
    queryClient.clear();
  });

  it("keeps a freshly-created epic tab unconfirmed by the host but marked created-this-session (terminal-agent path, no handoff)", async () => {
    const { queryClient } = mountReconcilerHarness();

    // Terminal-agent create registers no initial-chat handoff, so only the
    // synchronous created-this-session marker protects FRESH_EPIC_ID here.
    act(() => {
      useEpicCanvasStore.getState().openEpicTab(FRESH_EPIC_ID, "Fresh");
      useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale");
      markEpicCreatedThisSession(FRESH_EPIC_ID);
    });

    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    expect(collectOpenEpicIds()).toContain(FRESH_EPIC_ID);
    queryClient.clear();
  });

  it("keeps a restored Phase-mode ref while pruning an ordinary stale Epic", async () => {
    const { queryClient } = mountReconcilerHarness();

    act(() => {
      useEpicCanvasStore
        .getState()
        .openPhaseMigrationTabWithId(
          RESTORED_PHASE_TAB_ID,
          RESTORED_PHASE_ID,
          "Restored Phase",
        );
      useEpicCanvasStore.getState().openEpicTab(STALE_EPIC_ID, "Stale");
    });

    await waitFor(() => {
      expect(collectOpenEpicIds()).not.toContain(STALE_EPIC_ID);
    });
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(
      RESTORED_PHASE_TAB_ID,
    );
    expect(
      useEpicCanvasStore.getState().tabsById[RESTORED_PHASE_TAB_ID]
        ?.surfaceMode,
    ).toEqual({ kind: "phase-migration", phaseId: RESTORED_PHASE_ID });
    queryClient.clear();
  });

  it("retries tab reconciliation after an in-flight compatibility interruption", async () => {
    const taskContextsDeferred = createDeferred<GetTaskContextsResponse>();
    const methods: string[] = [];
    const getTaskContexts = vi.fn(
      (_params: GetTaskContextsRequest) => taskContextsDeferred.promise,
    );
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient, host } = mountStartupConsumers({
      hostStatus: () => compatibleHostStatus,
      getTaskContexts,
      listHarnesses,
      onMethod: (method) => {
        methods.push(method);
      },
    });

    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(1);
    });

    act(() => {
      host.setLocalHost(null);
    });
    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("checking");
    });

    act(() => {
      host.setLocalHost(localSnapshot);
    });
    await waitFor(() => {
      expect(getTaskContexts).toHaveBeenCalledTimes(2);
    });

    act(() => {
      taskContextsDeferred.resolve({
        tasks: { [STARTUP_EPIC_ID]: epicTask(STARTUP_EPIC_ID) },
      });
    });
    expect(methods[0]).toBe("host.status");
    queryClient.clear();
  });
});
