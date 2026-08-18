import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
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
 * Ticket 12 successor to `epic-shell-cost-badge.test.tsx` (ticket-7
 * fixup-01's regression coverage): the AMBIENT badge is gone by design, so
 * its "renders a stuck-pending query self-heals via poll" scenario no
 * longer has a subject. What survives is the mount-composition discipline
 * that test existed to prove - a real `<EpicShell>` / `<EpicSessionProvider>`
 * tree over a real `HostClient` + `MockHostMessenger`, not a module-mocked
 * substitute - now applied to the numberless entry point and the dialog it
 * opens on demand.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-usage-entry-point-live";
const TAB_ID = "epic-usage-entry-point-live-tab";

type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
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
      hostBuckets: [],
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

const usageSummaryCallCount = { current: 0 };
/** Every `host.usage.summary` request payload this suite has seen, in order. */
const usageSummaryRequests: UsageSummaryRequest[] = [];

const liveHostClientSpine = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  findHostById: (hostId) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
    handlers: {
      "host.usage.summary": (request: UsageSummaryRequest) => {
        usageSummaryCallCount.current += 1;
        usageSummaryRequests.push(request);
        return pricedUsageSummaryResponse();
      },
      "worktree.listAllForHost": () => emptyWorktreeListResponse(),
    },
  }),
});
liveHostClientSpine.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);
const liveHostClient = liveHostClientSpine.createRequester(mockLocalHostEntry);

const authService = {
  revalidateCurrentContext: vi.fn(() => Promise.resolve({ kind: "valid" })),
};

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => liveHostClient,
    // The SPINE, a separate export since redesign P2.1.
    useHostRuntimeClient: () => liveHostClient,
    useHostBinding: () => ({ hostClient: liveHostClient }),
    useAuthService: () => authService,
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === HOST_ID ? liveHostClient : null,
}));

// The app-wide EFFECTIVE host, kept MOVABLE so one arm below can pull it away
// from the Epic session's host. `EpicUsageEntryPoint` used to read this hook
// and now reads the session's host instead; with both pinned to `HOST_ID` the
// two are indistinguishable, and the suite would go on passing against the
// defect it is meant to hold closed.
const effectiveHostId = vi.hoisted(() => ({ current: "" }));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => effectiveHostId.current,
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
    const stream: ControlledStream = { callbacks, closeCount: 0 };
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
  return { streams: () => streams };
}

function renderShell(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <EpicSessionProvider epicId={EPIC_ID} tabId={TAB_ID}>
          <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
        </EpicSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<EpicShell /> usage entry point - real host RPC round trip", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    usageSummaryCallCount.current = 0;
    usageSummaryRequests.length = 0;
    effectiveHostId.current = HOST_ID;
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    resetNegotiatedManifests();
  });

  it("renders a numberless entry point once the session is live and the host has negotiated host.usage.summary - never fetching ambiently", async () => {
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

    const entryPoint = await screen.findByTestId("epic-usage-entry-point");
    expect(entryPoint.textContent).toBe("");
    // Give any accidental ambient fetch a tick to fire before asserting it
    // never did - the whole point of the on-demand redesign.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageSummaryCallCount.current).toBe(0);
    expect(screen.queryByTestId("epic-usage-dialog")).toBeNull();

    queryClient.clear();
  });

  it("stays on the RETAINED session's host while a re-point to another host establishes", async () => {
    // The reachable divergence, driven rather than asserted: the effective
    // host moves from A to B, `EpicSessionProvider` starts a replacement, and
    // it does NOT complete - the second stream is never given a snapshot here,
    // which is exactly what a slow or failed re-point looks like. Through all
    // of it the A handle stays registered and RENDERED, and only the canvas is
    // made inert (`epic-shell.tsx` passes `readOnly` to the tile subtree
    // alone), so this status row remains interactive.
    //
    // Note the test could not create this state by starting at B: the session's
    // host is derived FROM the effective host, so the two only diverge once a
    // session already exists. That is why the flip happens after the first
    // snapshot lands.
    //
    // ONLY A advertises the method, which is what makes the assertion decisive
    // rather than decorative: a build reading `useEffectiveHostId()` resolves
    // `host-elsewhere`, whose manifest has no `host.usage.summary`, and the
    // entry point disappears.
    recordNegotiatedHostMethods(HOST_ID, ["host.usage.summary"]);
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60_000 },
      },
    });

    const view = renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    // Premise: the entry point is up on the session's own host before anything
    // moves. Without this the assertion after the flip proves nothing - an
    // element that was never there cannot survive.
    await screen.findByTestId("epic-usage-entry-point");

    effectiveHostId.current = "host-elsewhere";
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <EpicSessionProvider epicId={EPIC_ID} tabId={TAB_ID}>
            <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
          </EpicSessionProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    // The replacement really was started and really has not settled - a
    // re-point that never began would leave this passing for the wrong reason.
    await waitFor(() => {
      expect(controlled.streams().length).toBeGreaterThan(1);
    });

    expect(screen.queryByTestId("epic-usage-entry-point")).not.toBeNull();

    queryClient.clear();
  });

  it("renders nothing when the host has not negotiated host.usage.summary - unsupported stays silent, not a crash", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("epic-usage-entry-point")).toBeNull();

    queryClient.clear();
  });

  it("opens the scoped panel on click and fetches the real cost figure only then", async () => {
    recordNegotiatedHostMethods(HOST_ID, ["host.usage.summary"]);
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60_000 },
      },
    });
    const user = userEvent.setup();

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    const entryPoint = await screen.findByTestId("epic-usage-entry-point");
    expect(usageSummaryCallCount.current).toBe(0);

    await user.click(entryPoint);

    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(costFigure.textContent).toContain("$0.11");
    expect(usageSummaryCallCount.current).toBeGreaterThan(0);
    // Scope, not just traffic: a host-wide request would answer with every
    // epic's usage and this panel would show it under one epic's name.
    expect(usageSummaryRequests.at(0)).toMatchObject({ epicId: EPIC_ID });

    queryClient.clear();
  });
});
