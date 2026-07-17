import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PrLightItem,
  PrSubscribeListForEpicServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pickAutoExpandItem } from "@/lib/pr/pr-list-projection";
import { prDetailTileId } from "@/lib/pr/pr-detail-tile";
import {
  PR_PANEL_PERSIST_KEY,
  migratePrPanelPersistedState,
  usePrPanelStore,
  type PrPanelExpandedRow,
} from "@/stores/epics/pr-panel-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { TilePane } from "@/stores/epics/canvas/tile-tree";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host1",
}));

// `PrListRow` pulls in the per-Epic Y.doc-backed owner-label chain
// (`useChatById` / `useEpicTerminalAgent`, which need a live
// `OpenEpicStoreHandle`) that has nothing to do with the expansion/persist
// semantics under test here. Stub it to a minimal clickable row that still
// exercises the REAL toggle wiring in `pr-panel-body.tsx` (`handleToggle`
// calling the real `usePrPanelStore`), keeping the WS transport as the only
// faked external boundary plus this one unrelated presentational seam. The
// stub also forwards `onOpenFullView` (T6) as a plain button so the panel's
// real row-click -> tile-open wiring is exercised without pulling in the
// real `PrListRow`'s Y.doc dependency.
vi.mock("@/components/epic-canvas/pr/pr-list-row", () => ({
  PrListRow: (props: {
    readonly item: PrLightItem;
    readonly expanded: boolean;
    readonly onToggle: () => void;
    readonly onOpenFullView: (() => void) | null;
  }) => {
    const label =
      props.item.base !== null
        ? `${props.item.base.owner}/${props.item.base.repo}#${props.item.base.prNumber}`
        : (props.item.headRefName ?? "unknown-head");
    return (
      <div>
        <button
          type="button"
          data-testid={`mock-pr-row-${label}`}
          data-expanded={props.expanded ? "true" : "false"}
          onClick={props.onToggle}
        >
          {label}
        </button>
        {props.expanded && props.onOpenFullView !== null ? (
          <button
            type="button"
            data-testid="pr-open-full-view"
            onClick={props.onOpenFullView}
          >
            Open full view
          </button>
        ) : null}
      </div>
    );
  },
}));

import { PrPanelBody } from "@/components/epic-canvas/pr/pr-panel-body";

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    // No-op for this test.
  }

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(frame: PrSubscribeListForEpicServerFrame): void {
    if (this.serverFrameHandler !== null) {
      const handler = this.serverFrameHandler;
      const envelope = { ...frame } satisfies StreamFrameEnvelope;
      handler(envelope, null);
    }
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  sessions: Map<string, MockStreamSession> = new Map();
  subscribeCallCount: number = 0;

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCallCount += 1;
    const key = JSON.stringify({ method, params });

    if (!this.sessions.has(key)) {
      this.sessions.set(key, new MockStreamSession());
    }

    const session = this.sessions.get(key);
    if (session === undefined) {
      throw new Error("Session not found");
    }
    return session;
  }

  getSession(method: string, params: unknown): MockStreamSession | undefined {
    const key = JSON.stringify({ method, params });
    return this.sessions.get(key);
  }
}

/** Minimal, fully-populated `PrLightItem` fixture builder - every required
 * field gets a realistic default; callers override only what the case cares
 * about. */
function buildPrItem(overrides: Partial<PrLightItem>): PrLightItem {
  return {
    githubHost: null,
    base: null,
    prUrl: null,
    state: "open",
    liveness: "live",
    observedAt: null,
    isDraft: false,
    title: "Test PR",
    baseRefName: "main",
    headRefName: "feature/test",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    commentCount: 0,
    updatedAt: 1_000,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    owners: [],
    ...overrides,
  };
}

function resetPrPanelStore(): void {
  window.localStorage.clear();
  usePrPanelStore.setState({ stateByEpicId: {} });
}

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

/** Narrows a parsed `zustand/persist` localStorage blob to `{ state }` without an `as` cast. */
function hasStateField(value: unknown): value is { readonly state: unknown } {
  return typeof value === "object" && value !== null && "state" in value;
}

describe("PrPanelBody expansion persistence", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const renderPanel = (props: { epicId: string; tabId: string }) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <StreamRuntimeContext.Provider
            value={{ wsStreamClient: mockWsStreamClient }}
          >
            <PrPanelBody epicId={props.epicId} tabId={props.tabId} />
          </StreamRuntimeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  };

  beforeEach(() => {
    resetPrPanelStore();
    resetCanvas();
    nestedFocusBoundaryMock.navigateNested.mockClear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    cleanup();
    resetPrPanelStore();
    resetCanvas();
    queryClient.clear();
  });

  it("expanding an unknown-base (list-only) row stays transient and never persists a non-null row", async () => {
    const epicId = "epic-c1";
    // Pre-mark the epic as already visited (nothing expanded yet) so the
    // first-open auto-expand effect - covered separately below - does not
    // fire and interfere with this toggle-only assertion. Seeded via
    // `setState` directly (not the `setExpandedPr` action): that action
    // bails as a no-op when the epic is unvisited and the target is already
    // `null` (`expandedRowsEqual(null, null)` short-circuits), which would
    // never actually create the `stateByEpicId[epicId]` entry.
    usePrPanelStore.setState({
      stateByEpicId: { [epicId]: { expandedPr: null } },
    });

    const unknownBaseItem = buildPrItem({
      base: null,
      githubHost: null,
      prUrl: null,
      headRefName: "unknown/head",
    });

    renderPanel({ epicId, tabId: "tab-c1" });

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      items: [unknownBaseItem],
    });

    const row = await screen.findByTestId("mock-pr-row-unknown/head");
    expect(row.getAttribute("data-expanded")).toBe("false");

    fireEvent.click(row);

    await waitFor(() => {
      expect(row.getAttribute("data-expanded")).toBe("true");
    });
    // Transient-only: the store's persisted expansion for this epic must
    // remain null, never a non-null row, for an unknown-base toggle.
    expect(
      usePrPanelStore.getState().stateByEpicId[epicId].expandedPr,
    ).toBeNull();
  });

  it("expanding a fully-identified row persists into usePrPanelStore, and a fresh read after 'reload' returns the same row", async () => {
    const epicId = "epic-c2";
    usePrPanelStore.setState({
      stateByEpicId: { [epicId]: { expandedPr: null } },
    });

    const identifiedItem = buildPrItem({
      base: { owner: "acme", repo: "widgets", prNumber: 42 },
      githubHost: "github.com",
      prUrl: "https://github.com/acme/widgets/pull/42",
      headRefName: "feature/known",
    });

    renderPanel({ epicId, tabId: "tab-c2" });

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      items: [identifiedItem],
    });

    const row = await screen.findByTestId("mock-pr-row-acme/widgets#42");
    fireEvent.click(row);

    const expectedRow: PrPanelExpandedRow = {
      hostId: "host1",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    };

    await waitFor(() => {
      expect(
        usePrPanelStore.getState().stateByEpicId[epicId].expandedPr,
      ).toEqual(expectedRow);
    });

    // Simulate "restored after reload": read the persisted localStorage
    // blob and run it through the SAME `migratePrPanelPersistedState` the
    // persist middleware calls on rehydration, rather than trusting the
    // live in-memory store.
    await waitFor(() => {
      expect(window.localStorage.getItem(PR_PANEL_PERSIST_KEY)).not.toBeNull();
    });
    const raw = window.localStorage.getItem(PR_PANEL_PERSIST_KEY);
    const parsed: unknown = JSON.parse(raw ?? "{}");
    const parsedState = hasStateField(parsed) ? parsed.state : null;
    const restored = migratePrPanelPersistedState(parsedState);
    expect(restored.stateByEpicId[epicId].expandedPr).toEqual(expectedRow);
  });

  it("first-open auto-expand wiring: the effect picks via pickAutoExpandItem and persists it on first frame, without any click", async () => {
    const epicId = "epic-c3";
    // No pre-seed here - the epic is genuinely unvisited, so the first-open
    // effect in `PrPanelBodyContent` must run.
    expect(usePrPanelStore.getState().stateByEpicId[epicId]).toBeUndefined();

    const openItem = buildPrItem({
      base: { owner: "acme", repo: "widgets", prNumber: 7 },
      githubHost: "github.com",
      prUrl: "https://github.com/acme/widgets/pull/7",
      state: "open",
      updatedAt: 500,
    });
    const mergedItem = buildPrItem({
      base: { owner: "acme", repo: "widgets", prNumber: 6 },
      githubHost: "github.com",
      prUrl: "https://github.com/acme/widgets/pull/6",
      state: "merged",
      updatedAt: 900,
    });

    renderPanel({ epicId, tabId: "tab-c3" });

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      items: [mergedItem, openItem],
    });

    const expectedRow: PrPanelExpandedRow = {
      hostId: "host1",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    };

    await waitFor(() => {
      expect(
        usePrPanelStore.getState().stateByEpicId[epicId].expandedPr,
      ).toEqual(expectedRow);
    });
  });

  it("(d) clicking 'Open full view' on an expanded, fully-identified row opens a pr-detail tile via the real canvas store", async () => {
    const epicId = "epic-d1";
    usePrPanelStore.setState({
      stateByEpicId: { [epicId]: { expandedPr: null } },
    });

    const item = buildPrItem({
      base: { owner: "acme", repo: "widgets", prNumber: 55 },
      githubHost: "github.com",
      prUrl: "https://github.com/acme/widgets/pull/55",
      headRefName: "feature/full-view",
      title: "Full view PR",
    });

    renderPanel({ epicId, tabId: "tab-d1" });

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      items: [item],
    });

    const row = await screen.findByTestId("mock-pr-row-acme/widgets#55");
    fireEvent.click(row);

    await waitFor(() => {
      expect(row.getAttribute("data-expanded")).toBe("true");
    });

    const openFullViewButton = await screen.findByTestId("pr-open-full-view");
    fireEvent.click(openFullViewButton);

    const expectedTileId = prDetailTileId({
      hostId: "host1",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 55,
    });

    const canvasState = useEpicCanvasStore.getState();
    const tabId = Object.keys(canvasState.tabsById).find(
      (id) => canvasState.tabsById[id]?.epicId === epicId,
    );
    expect(tabId).toBeDefined();
    if (tabId === undefined) return;

    const canvas = canvasState.canvasByTabId[tabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected a pane");
    const pane: TilePane = canvas.root;
    expect(pane.tabInstanceIds).toHaveLength(1);
    const tile = canvas.tilesByInstanceId[pane.tabInstanceIds[0]];
    expect(tile).toBeDefined();
    if (tile === undefined) return;

    expect(tile.id).toBe(expectedTileId);
    expect(tile.type).toBe("pr-detail");
    if (tile.type !== "pr-detail") throw new Error("expected a pr-detail tile");
    expect(tile.hostId).toBe("host1");
    expect(tile.githubHost).toBe("github.com");
    expect(tile.owner).toBe("acme");
    expect(tile.repo).toBe("widgets");
    expect(tile.prNumber).toBe(55);
  });
});

describe("pickAutoExpandItem (first-open auto-expand priority)", () => {
  it("returns null for an empty item list", () => {
    expect(pickAutoExpandItem([])).toBeNull();
  });

  it("tier 1: an open PR with failing checks wins over any other open PR", () => {
    const openClean = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 1 },
      state: "open",
      checksRollup: { success: 3, failure: 0, pending: 0, total: 3 },
      updatedAt: 900,
    });
    const openFailing = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 2 },
      state: "open",
      checksRollup: { success: 1, failure: 1, pending: 0, total: 2 },
      updatedAt: 100,
    });
    const merged = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 3 },
      state: "merged",
      updatedAt: 2_000,
    });

    const pick = pickAutoExpandItem([openClean, openFailing, merged]);
    expect(pick).not.toBeNull();
    expect(pick?.base?.prNumber).toBe(2);
  });

  it("tier 1 tie-break: among multiple open-failing PRs, the most recently updated wins", () => {
    const olderFailing = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 10 },
      state: "open",
      checksRollup: { success: 0, failure: 1, pending: 0, total: 1 },
      updatedAt: 100,
    });
    const newerFailing = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 11 },
      state: "open",
      checksRollup: { success: 0, failure: 2, pending: 0, total: 2 },
      updatedAt: 500,
    });

    const pick = pickAutoExpandItem([olderFailing, newerFailing]);
    expect(pick?.base?.prNumber).toBe(11);
  });

  it("tier 2: absent any failing-checks open PR, any open PR wins over merged/closed", () => {
    const openNoChecks = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 20 },
      state: "open",
      checksRollup: null,
      updatedAt: 50,
    });
    const mergedRecent = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 21 },
      state: "merged",
      updatedAt: 9_999,
    });
    const closedRecent = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 22 },
      state: "closed",
      updatedAt: 9_998,
    });

    const pick = pickAutoExpandItem([mergedRecent, closedRecent, openNoChecks]);
    expect(pick?.base?.prNumber).toBe(20);
  });

  it("tier 3: absent any open PR, the most-recently-updated PR overall wins", () => {
    const olderMerged = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 30 },
      state: "merged",
      updatedAt: 100,
    });
    const newerClosed = buildPrItem({
      base: { owner: "a", repo: "b", prNumber: 31 },
      state: "closed",
      updatedAt: 800,
    });

    const pick = pickAutoExpandItem([olderMerged, newerClosed]);
    expect(pick?.base?.prNumber).toBe(31);
  });
});
