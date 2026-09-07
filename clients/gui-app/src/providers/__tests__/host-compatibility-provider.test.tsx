import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
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
import { hostStatusProbeQueryKey } from "@/lib/host/compatibility-state";
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
import type {
  GetTaskContextsResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";

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
    placement: null,
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
  availability: "available",
};

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;
type GetTaskContextsRequest = RequestOfMethod<
  HostRpcRegistry,
  "epic.getTaskContexts"
>;
type TaskContextRow = GetTaskContextsResponse["tasks"][string];
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
  readonly getTaskContexts: (
    params: GetTaskContextsRequest,
  ) => Promise<GetTaskContextsResponse> | GetTaskContextsResponse;
  readonly listHarnesses: () =>
    | Promise<ListHarnessesResponse>
    | ListHarnessesResponse;
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
  busyBreakdown: null,
  // `null` = this fixture's host did not report the durable attempt,
  // which is exactly what host.status@1.2-and-older peers send.
  updateOperation: null,
  updateTransaction: null,
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
        "epic.getTaskContexts": (params) => {
          options.onMethod("epic.getTaskContexts");
          return options.getTaskContexts(params);
        },
        "agent.gui.listHarnesses": () => {
          options.onMethod("agent.gui.listHarnesses");
          return options.listHarnesses();
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

/** Status cannot say whether a compatible verdict is held through a failed refetch, or whether a failed probe ever reached the host. */
function compatibilityDetail(compatibility: HostCompatibility): string {
  if (compatibility.status === "compatible") {
    return compatibility.degraded ? "degraded" : "live";
  }
  if (compatibility.status === "failed") {
    return compatibility.unreachable ? "unreachable" : "rejected";
  }
  return "n/a";
}

/** Surfaces the host.status payload fields carried on a `compatible` verdict (busy / busySessionCount / hostVersion). Non-compatible arms never hold one. */
function hostStatusDetail(compatibility: HostCompatibility): string {
  if (compatibility.status !== "compatible") return "none";
  const snapshot = compatibility.hostStatus;
  return `busy=${String(snapshot.busy)};count=${String(snapshot.busySessionCount)};version=${snapshot.hostVersion}`;
}

/** Assert the store verdict, not status text: an incompatible host is dropped from derivation, so the bound-host hook falls back to checking. */
function authorityIncompatibleCode(hostId: string): string | null {
  const lease = useSelectionAuthorityStore
    .getState()
    .leases.find((entry) => entry.hostId === hostId);
  if (lease === undefined || lease.status !== "dead") return null;
  if (lease.dead.reason !== "incompatible") return null;
  return lease.dead.detail.code;
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

function epicTask(epicId: string): ListTaskLight {
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

// Response keyed by requested ids: found or positive absence. Nothing about
// ids not asked.
function taskContextsFor(
  confirmedEpicIds: ReadonlyArray<string>,
): (params: GetTaskContextsRequest) => GetTaskContextsResponse {
  const confirmed = new Set(confirmedEpicIds);
  return (params) => ({
    tasks: Object.fromEntries(
      params.taskIds.map((taskId): readonly [string, TaskContextRow] => [
        taskId,
        confirmed.has(taskId)
          ? { status: "found", task: epicTask(taskId) }
          : { status: "confirmed-absent" },
      ]),
    ),
  });
}

// Shared harness for the "freshly-created epic survives reconciliation" tests.
// The host confirms only the pre-existing startup tab, so every other id is
// positively absent and would be pruned unless a protection guard exempts it.
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
  it("exposes the latest task-context response through the host registry", () => {
    expectTypeOf<
      ResponseOfMethod<HostRpcRegistry, "epic.getTaskContexts">
    >().toEqualTypeOf<GetTaskContextsResponse>();
  });

  beforeEach(() => {
    restoreFetch = installAuthFetch();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    // handleEpicAccessLoss reads useTabsStore layout, not the canvas store.
    // Install the real source-reconciliation subscription.
    tabCommandCoordinator.installSourceReconciliation();
    // Seed epic.getTaskContexts on the manifest. MockHostMessenger has no
    // handshake; without it the reconciler refuses and prune assertions pass vacuously.
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
    // The one test in this file that seeds the selection authority store
    // directly (simulating an in-app host switch, redesign P4.2) - reset it
    // so a later test's runtime does not attach onto leftover module state.
    useSelectionAuthorityStore.getState().reset();
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
      expect(authorityIncompatibleCode(localSnapshot.hostId)).toBe(
        "INCOMPATIBLE",
      );
    });
    // The load-bearing half, unchanged: an incompatible host is probed once
    // and nothing else is ever dispatched to it.
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

  it("a still-dialing probe yields checking, not failed", async () => {
    // RetryableTransportError with no held data is not a settled verdict.
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        throw new RetryableTransportError({
          replaySafetyFromKey: false,
          code: "RPC_ERROR",
          message: "Remote session is not ready",
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
      expect(getCompatibilityStatusText()).toBe("checking");
    });
    expect(getCompatibilityDetailText()).toBe("n/a");
    expect(getTaskContexts).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("a settled HostTransportFailureError still yields failed + unreachable", async () => {
    // Plain transport failure (session closed / host down) is a settled
    // answer, not a still-dialing one - D5.1 only parks pending-class errors.
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        throw new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "WebSocket closed before next frame",
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

  it("a HostRequestAbortedError on a first probe yields checking, not failed", async () => {
    // Bind-time cancellation is the third pending-class case: an abort on the
    // active key must not settle a failed verdict for the host that just
    // became active.
    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
    const { queryClient } = mountStartupConsumers({
      hostStatus: () => {
        throw new HostRequestAbortedError({
          message: "request aborted by host rebind",
          requestId: "req-status",
          method: "host.status",
        });
      },
      getTaskContexts,
      listHarnesses,
      onMethod: () => undefined,
    });

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("checking");
    });
    expect(getCompatibilityDetailText()).toBe("n/a");
    queryClient.clear();
  });

  it("verdict for A survives bind A→B→A from the session-lived cache", async () => {
    // gcTime Infinity: A->B->A must not bounce through checking.
    const hostB: HostDirectoryEntry = {
      hostId: "desktop-host-b",
      label: "Host B",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4918/rpc",
      version: "1.2.3",
      transportDialability: "dialable",
    };
    const hostA: HostDirectoryEntry = {
      hostId: localSnapshot.hostId,
      label: localSnapshot.displayName,
      kind: "local",
      websocketUrl: localSnapshot.websocketUrl,
      version: localSnapshot.version,
      transportDialability: "dialable",
    };
    recordNegotiatedHostMethods(hostB.hostId, [
      "host.status",
      "epic.getTaskContexts",
      "agent.gui.listHarnesses",
    ]);

    const getTaskContexts = vi.fn(taskContextsFor([STARTUP_EPIC_ID]));
    const listHarnesses = vi.fn((): ListHarnessesResponse => ({
      harnesses: [],
    }));
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
    useEpicCanvasStore
      .getState()
      .openEpicTab(STARTUP_EPIC_ID, "Startup Compat");

    const queryClient = buildQueryClient();
    render(
      <RunnerHostProvider runnerHost={host}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={buildMessengerFactory({
              hostStatus: () => compatibleHostStatus,
              getTaskContexts,
              listHarnesses,
              onMethod: () => undefined,
            })}
            invalidator={null}
            requestId={null}
            // B must be a directory row from the start; findHostById is
            // directory.findById, so an unlisted id is unbound.
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [hostB] })
            }
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <HostCompatibilityProvider>
              <CompatibilityStatusProbe />
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });
    // A's probe entry is in the session-lived cache under its host-scoped key.
    expect(
      queryClient.getQueryData(hostStatusProbeQueryKey(hostA.hostId)),
    ).toBeDefined();
    // Assert retention directly. Default 5-minute gcTime still holds the entry
    // milliseconds later, so A->B->A cannot discriminate Infinity.
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: hostStatusProbeQueryKey(hostA.hostId) })?.options
        .gcTime,
    ).toBe(Infinity);

    // In-app switch is the app-wide pointer moving. Write a fresh kernel
    // snapshot into the store useHostClient derives from.
    act(() => {
      useSelectionAuthorityStore.getState().applyKernelSnapshot({
        attached: true,
        preferredHostId: hostB.hostId,
        targetHostId: hostB.hostId,
        effectiveHostId: hostB.hostId,
        leases: [],
        selectionRevision: 1,
      });
    });
    // B is a different key - leave it in whatever state its first probe
    // settles. The pin is that A's entry survives the re-key, not that B
    // itself is healthy.
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostB.hostId,
    );

    // Switch back to A: the held verdict must be served in the same render
    // path - no intermediate "checking".
    act(() => {
      useSelectionAuthorityStore.getState().applyKernelSnapshot({
        attached: true,
        preferredHostId: hostA.hostId,
        targetHostId: hostA.hostId,
        effectiveHostId: hostA.hostId,
        leases: [],
        selectionRevision: 2,
      });
    });
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostA.hostId,
    );
    expect(getCompatibilityStatusText()).toBe("compatible");
    expect(getCompatibilityDetailText()).toBe("live");
    queryClient.clear();
  });

    /** Incoming host.status is invalidated on re-point; held verdict keeps rendering while that refetch is in flight. Hold the B->A refetch on a controlled promise. */
  it("D2: a re-point invalidates exactly the incoming host's probe entry and holds the verdict while it refetches", async () => {
    const hostA: HostDirectoryEntry = {
      hostId: localSnapshot.hostId,
      label: localSnapshot.displayName,
      kind: "local",
      websocketUrl: localSnapshot.websocketUrl,
      version: localSnapshot.version,
      transportDialability: "dialable",
    };
    const hostB: HostDirectoryEntry = {
      hostId: "desktop-host-b-d2",
      label: "Host B",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4918/rpc",
      version: "1.2.3",
      transportDialability: "dialable",
    };
    recordNegotiatedHostMethods(hostB.hostId, [
      "host.status",
      "epic.getTaskContexts",
      "agent.gui.listHarnesses",
    ]);

    // Opening probes 1 and 2 settle immediately. Probe 3 (A's reprobe after
    // B->A, where A already holds a verdict) is hand-controlled.
    const aReprobe = createDeferred<HostStatusResponse>();
    let hostStatusCalls = 0;
    const hostStatus = (): Promise<HostStatusResponse> | HostStatusResponse => {
      hostStatusCalls += 1;
      return hostStatusCalls <= 2 ? compatibleHostStatus : aReprobe.promise;
    };

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
    useEpicCanvasStore
      .getState()
      .openEpicTab(STARTUP_EPIC_ID, "Startup Compat");

    const queryClient = buildQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <RunnerHostProvider runnerHost={host}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={buildMessengerFactory({
              hostStatus,
              getTaskContexts: vi.fn(taskContextsFor([STARTUP_EPIC_ID])),
              listHarnesses: vi.fn((): ListHarnessesResponse => ({
                harnesses: [],
              })),
              onMethod: () => undefined,
            })}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [hostB] })
            }
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <HostCompatibilityProvider>
              <CompatibilityStatusProbe />
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });

    // 3. THE ABSTENTION: the OPENING derivation (`null` -> A, i.e. startup)
    // drove ZERO probe invalidations.
    const hostStatusInvalidations = (): unknown[][] =>
      invalidateSpy.mock.calls.filter(([filters]) => {
        const key = filters === undefined ? null : filters.queryKey;
        return Array.isArray(key) && key[2] === "host.status";
      });
    expect(hostStatusInvalidations()).toEqual([]);
    invalidateSpy.mockClear();

    // A -> B.
    act(() => {
      useSelectionAuthorityStore.getState().applyKernelSnapshot({
        attached: true,
        preferredHostId: hostB.hostId,
        targetHostId: hostB.hostId,
        effectiveHostId: hostB.hostId,
        leases: [],
        selectionRevision: 1,
      });
    });
    await waitFor(() => {
      expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
        hostB.hostId,
      );
    });
    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });

    // Incoming B: one invalidation on its exact probe key. Nothing for A, no
    // broader ["host"] sweep.
    expect(hostStatusInvalidations()).toEqual([
      [{ queryKey: hostStatusProbeQueryKey(hostB.hostId), exact: true }],
    ]);
    invalidateSpy.mockClear();

    // B -> A. A already holds a verdict from its opening probe, so THIS leg
    // is the one that can genuinely distinguish invalidate from reset.
    act(() => {
      useSelectionAuthorityStore.getState().applyKernelSnapshot({
        attached: true,
        preferredHostId: hostA.hostId,
        targetHostId: hostA.hostId,
        effectiveHostId: hostA.hostId,
        leases: [],
        selectionRevision: 2,
      });
    });

    // 2 (B->A leg). Same shape as above, scoped to A this time.
    await waitFor(() => {
      expect(hostStatusInvalidations()).toEqual([
        [{ queryKey: hostStatusProbeQueryKey(hostA.hostId), exact: true }],
      ]);
    });

    // The reprobe this invalidation triggered is genuinely in flight now.
    await waitFor(() => {
      expect(hostStatusCalls).toBe(3);
    });

    // While the reprobe is pending, render the held compatible verdict, not
    // checking.
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostA.hostId,
    );
    expect(getCompatibilityStatusText()).toBe("compatible");
    expect(getCompatibilityDetailText()).toBe("live");

    act(() => {
      aReprobe.resolve(compatibleHostStatus);
    });
    await waitFor(() => {
      expect(getCompatibilityDetailText()).toBe("live");
    });
    queryClient.clear();
  });

  // A failed compat refetch on stream recovery must not tear the workspace
  // down as if the host had not started.
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
          replaySafetyFromKey: false,
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
          replaySafetyFromKey: false,
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
    expect(authorityIncompatibleCode(localSnapshot.hostId)).toBeNull();

    await act(async () => {
      await queryClient.invalidateQueries();
    });

    // A replacement under the same id that is incompatible wins. Assert at the
    // authority; status text falls back to checking once unbound.
    await waitFor(() => {
      expect(authorityIncompatibleCode(localSnapshot.hostId)).toBe(
        "INCOMPATIBLE",
      );
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

    // FRESH_EPIC_ID is unconfirmed but has an initial-chat handoff; STALE_EPIC_ID
    // has none. Open both before host.status's later microtask.
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
      markEpicCreatedThisSession(FRESH_EPIC_ID, "host-1");
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
        tasks: {
          [STARTUP_EPIC_ID]: {
            status: "found",
            task: epicTask(STARTUP_EPIC_ID),
          },
        },
      });
    });
    expect(methods[0]).toBe("host.status");
    queryClient.clear();
  });
});
