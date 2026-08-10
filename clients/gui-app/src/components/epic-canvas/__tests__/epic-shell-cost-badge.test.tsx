import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRequestControlFlowError } from "@traycer-clients/shared/host-client/host-request-coordinator";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";

/**
 * Regression coverage for ticket-7 fixup-01: the epic cost badge rendered
 * fine against a hand-mocked `useHostClient` in isolation, but never
 * appeared in the live app. `epic-cost-badge.test.tsx` (and
 * `epic-shell.test.tsx`, which stubs `EpicConnectionPill` and never
 * negotiates `host.usage.summary`) both mock `@/lib/host` at the module
 * boundary - neither exercises the REAL `<EpicCostBadge>` mounted at its
 * real position inside the REAL `<EpicShell>` tree with a REAL host RPC
 * round trip. This file does: a real `HostClient` + `MockHostMessenger`
 * behind the same `useHostClient`/`useHostBinding` seam, driven through the
 * actual `EpicSessionProvider` + `EpicShell` composition, so a wiring bug
 * anywhere in that path - not just inside `EpicCostBadge` itself - fails
 * this test the way it failed live verification.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-cost-badge-live";
const TAB_ID = "epic-cost-badge-live-tab";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
type WorktreeListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listAllForHost"
>;

const ZERO_PROVENANCE_SPLIT: UsageSummaryResponse["summary"]["totals"]["provenanceSplit"] =
  {
    providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
    modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
    unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  };

function pricedUsageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: {
        timezone: "UTC",
        windowDays: 30,
        startAtInclusive: 0,
        endAtExclusive: 1,
      },
      epicId: EPIC_ID,
      chatId: null,
      totals: {
        factCount: 1,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 0.113,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: "modelPriced",
        provenanceSplit: ZERO_PROVENANCE_SPLIT,
      },
      buckets: [
        {
          day: "2026-08-09",
          harnessId: "claude",
          model: "claude-sonnet-5",
          factCount: 1,
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          knownCostUsd: 0.113,
          knownCacheSavingsUsd: 0,
          knownReasoningTokens: 0,
          costProvenance: "modelPriced",
        },
      ],
      chatBuckets: [],
      distinctEpicCount: 1,
      distinctChatCount: 1,
      outcomeBreakdown: {
        completed: 1,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 1, partial: 0, absent: 0 },
      turnRows: null,
      turnRowsTruncated: false,
    },
    coverage: {
      pricedFactCount: 1,
      unpricedFactCount: 0,
      pricedTokenCount: 150,
      unpricedTokenCount: 0,
    },
  };
}

function emptyWorktreeListResponse(): WorktreeListResponse {
  return { worktrees: [], nextCursor: null };
}

// Mutable so individual tests can swap in a handler that fails the FIRST call
// (simulating a coordinator control-flow cancellation) without rebuilding the
// whole `HostClient`/`EpicSessionProvider` harness per test.
const usageSummaryHandler = {
  current: (): UsageSummaryResponse => pricedUsageSummaryResponse(),
};

// A real `HostClient` bound to the mock local host and driven through a real
// `MockHostMessenger`, so `host.usage.summary` actually dispatches by method
// instead of a blanket stub response - the same seam every other production
// consumer of `useHostClient()` goes through.
const liveHostClient = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
    handlers: {
      "host.usage.summary": () => usageSummaryHandler.current(),
      "worktree.listAllForHost": () => emptyWorktreeListResponse(),
    },
  }),
});
liveHostClient.bind(mockLocalHostEntry);
liveHostClient.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);

const authService = {
  revalidateCurrentContext: vi.fn(() => Promise.resolve({ kind: "valid" })),
};

// Mirrors `epic-shell.test.tsx`'s seam: `@/lib/host` mocked so the shell
// mounts without the full `HostRuntimeProvider` bootstrap - but backed by the
// REAL `HostClient` above (not an ad hoc plain object), so `useHostClient()`
// and `useReactiveActiveHostId()` behave exactly as they do in production.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => liveHostClient,
    useHostBinding: () => ({ hostClient: liveHostClient }),
    useAuthService: () => authService,
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const openTransportStub = vi.hoisted(() => () => {
  throw new Error("openTransport must not be called in this test");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    data: undefined,
    variables: undefined,
  }),
}));

// Irrelevant to this regression (its own Y.Doc-backed sync state, no host
// RPC) - stubbed exactly like `epic-shell.test.tsx` so failures here can only
// come from the cost badge / host-RPC path this file exists to exercise.
vi.mock("@/components/epic-canvas/panels/epic-connection-pill", () => ({
  EpicConnectionPill: () => <div data-testid="epic-connection-pill" />,
}));

vi.mock("@/components/epic-canvas/panels/epic-connection-toasts", () => ({
  EpicConnectionToasts: () => null,
}));

vi.mock("@/components/epic-canvas/canvas/tile-canvas", () => ({
  TileCanvas: () => <div data-testid="tile-canvas-stub" />,
}));

interface ControlledStream {
  readonly callbacks: EpicStreamCallbacks;
  closeCount: number;
}

function buildMeta(
  title: string,
  permissionRole: PermissionRole | null,
): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight:
      permissionRole === null
        ? null
        : {
            id: EPIC_ID,
            title,
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "open",
            createdAt: 0,
            updatedAt: 0,
            createdBy: "u",
            version: "1",
          },
    permissionRole,
    repos: [
      {
        task: null,
        repoIdentifier: { owner: "traycer", repo: "cached-repo" },
        createdAt: 0,
        createdBy: "u",
      },
    ],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function buildSnapshot(title: string): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap("epic");
  epic.set("title", title);
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(donor);
}

function installControlledFactory(): {
  readonly streams: () => ReadonlyArray<ControlledStream>;
} {
  const streams: ControlledStream[] = [];
  __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
    const stream: ControlledStream = {
      callbacks,
      closeCount: 0,
    };
    streams.push(stream);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        stream.closeCount += 1;
      },
    };
  });
  return {
    streams: () => streams,
  };
}

function renderShell(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
          <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
        </EpicSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<EpicShell /> cost badge - real host RPC round trip", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    usageSummaryHandler.current = () => pricedUsageSummaryResponse();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    resetNegotiatedManifests();
  });

  it("renders the cost badge once the session is live and the host has negotiated host.usage.summary", async () => {
    recordNegotiatedHostMethods(HOST_ID, ["host.usage.summary"]);
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60_000 },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    // The connection pill (stubbed) is the existing signal that the status
    // row itself has mounted with `snapshotLoaded: true` - same gate the
    // cost badge sits behind.
    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });

    expect((await screen.findByTestId("epic-cost-badge")).textContent).toBe(
      "$0.11",
    );

    queryClient.clear();
  });

  it("still renders nothing when the host has not negotiated host.usage.summary - unsupported stays silent, not a crash", async () => {
    // No `recordNegotiatedHostMethods` call for this host: fails closed.
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60_000 },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });

    // Give the (disabled) query a tick to settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("epic-cost-badge")).toBeNull();

    queryClient.clear();
  });

  it("picks up the badge once negotiation completes AFTER the pane has already mounted - not stuck in its first-render disabled state", async () => {
    // Mirrors the real boot order: the epic pane can mount and reach
    // `snapshotLoaded` before the WS handshake's negotiated-manifest write
    // for this OPTIONAL method lands - `host.usage.summary` is not part of
    // the released floor, so nothing blocks the pane on it. This is the
    // exact "disabled-query mirror" / "never re-evaluates" suspect from the
    // fixup ticket: does the badge's query actually flip on once `supported`
    // goes true, or is it wedged from its first (unsupported) render?
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60_000 },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-cost-badge")).toBeNull();

    // Negotiation lands well after the pane is already up and settled.
    recordNegotiatedHostMethods(HOST_ID, ["host.usage.summary"]);

    expect((await screen.findByTestId("epic-cost-badge")).textContent).toBe(
      "$0.11",
    );

    queryClient.clear();
  });

  it("self-heals from a coordinator control-flow cancellation on its first fetch, instead of staying stuck pending forever", async () => {
    // Reproduces the fixup ticket's actual root cause mechanically:
    // `HostClient` cancels an in-flight request on a host-bind/auth-context
    // transition by throwing `HostRequestControlFlowError`, which
    // `withHostQueryErrorBoundary` (host-query-error-boundary.ts) turns into
    // a SILENT, REVERTING `CancelledError` - the query lands back on
    // `data: undefined, error: null`, and this method's OLD `poll: null`
    // policy left it there permanently (no window-focus/reconnect refetch,
    // no periodic refetch, nothing else watching it). The badge - unlike its
    // always-enabled siblings - only starts fetching once `supported` flips
    // true, which is exactly the startup window such a transition is most
    // likely to land in. `poll: { kind: "fixed", intervalMs: 15 * MINUTE }`
    // is the self-heal: without it this test times out with the badge
    // permanently absent; with it, the badge appears once the interval fires
    // a fresh fetch that succeeds.
    vi.useFakeTimers();
    recordNegotiatedHostMethods(HOST_ID, ["host.usage.summary"]);
    usageSummaryHandler.current = () => {
      throw new HostRequestControlFlowError("authority-superseded");
    };
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60_000 },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    await vi.waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    // The first fetch was silently cancelled and reverted: still nothing to
    // show, and nothing has thrown or surfaced an error card - matches the
    // documented "unsupported/zero-usage" render-nothing shape from the
    // outside, even though the actual state is neither.
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("epic-cost-badge")).toBeNull();

    // Now let the handler succeed - the interval firing is what has to pick
    // this up, since nothing else will retry a silently-reverted query.
    usageSummaryHandler.current = () => pricedUsageSummaryResponse();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    await vi.waitFor(() => {
      expect(screen.getByTestId("epic-cost-badge").textContent).toBe("$0.11");
    });

    queryClient.clear();
    vi.useRealTimers();
  });
});
