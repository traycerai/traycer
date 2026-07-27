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
import { prDetailTileId } from "@/lib/pr/pr-detail-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { TilePane } from "@/stores/epics/canvas/tile-tree";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host1",
}));

// `PrRow` pulls in the per-Epic Y.doc-backed owner-label chain
// (`useChatById` / `useEpicTerminalAgent`, which need a live
// `OpenEpicStoreHandle`) that has nothing to do with the panel wiring under
// test here. Stub it to a minimal clickable row that still exercises the
// REAL row-click -> tile-open wiring in `pr-panel-body.tsx`, keeping the WS
// transport as the only faked external boundary plus this one unrelated
// presentational seam. Linked (nested submodule) rows render as their own
// buttons so the panel's nesting decisions stay observable here.
vi.mock("@/components/epic-canvas/pr/pr-row", () => {
  const mockLabel = (item: PrLightItem): string =>
    item.base !== null
      ? `${item.base.owner}/${item.base.repo}#${item.base.prNumber}`
      : (item.headRefName ?? "unknown-head");
  const mockEntry = (
    entry: {
      readonly item: PrLightItem;
      readonly tileId: string | null;
      readonly onOpen: (() => void) | null;
    },
    prefix: string,
  ) => (
    <button
      type="button"
      key={mockLabel(entry.item)}
      data-testid={`${prefix}-${mockLabel(entry.item)}`}
      data-openable={entry.onOpen !== null ? "true" : "false"}
      data-tile-id={entry.tileId ?? ""}
      onClick={() => entry.onOpen?.()}
    >
      {mockLabel(entry.item)}
    </button>
  );
  return {
    PrRow: (props: {
      readonly entry: {
        readonly item: PrLightItem;
        readonly tileId: string | null;
        readonly onOpen: (() => void) | null;
      };
    }) => <div>{mockEntry(props.entry, "mock-pr-card")}</div>,
  };
});

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

  requestReconnect(): void {
    // No-op for this test; reconnect is owned by the real StreamSession.
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
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

describe("PrPanelBody card list", () => {
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

  const emitSnapshot = async (
    epicId: string,
    items: readonly PrLightItem[],
  ): Promise<MockStreamSession> => {
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("missing list session");
    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      items: [...items],
    });
    return session;
  };

  beforeEach(() => {
    resetCanvas();
    nestedFocusBoundaryMock.navigateNested.mockClear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    cleanup();
    resetCanvas();
    queryClient.clear();
  });

  it("renders a worktrees-style repo header (label + count) over one always-expanded card per PR", async () => {
    const epicId = "epic-h1";
    renderPanel({ epicId, tabId: "tab-h1" });
    await emitSnapshot(epicId, [
      buildPrItem({
        base: { owner: "acme", repo: "widgets", prNumber: 1 },
        githubHost: "github.com",
        prUrl: "https://github.com/acme/widgets/pull/1",
      }),
      buildPrItem({
        headRefName: "feature/unknown-base",
        repoIdentifier: { owner: "acme", repo: "widgets" },
      }),
    ]);

    const header = await screen.findByTestId("pr-repo-group-header");
    expect(header.textContent).toContain("acme/widgets");
    expect(header.textContent).toContain("2");
    // Both cards render directly - no expansion affordance exists anymore.
    expect(screen.getByTestId("mock-pr-card-acme/widgets#1")).toBeTruthy();
    expect(
      screen.getByTestId("mock-pr-card-feature/unknown-base"),
    ).toBeTruthy();
  });

  it("gives an owned-submodule PR its own repo group directly under its superproject's", async () => {
    const epicId = "epic-l1";
    renderPanel({ epicId, tabId: "tab-l1" });
    await emitSnapshot(epicId, [
      buildPrItem({
        base: { owner: "acme", repo: "widgets", prNumber: 1 },
        githubHost: "github.com",
        prUrl: "https://github.com/acme/widgets/pull/1",
        linkGroupKey: "/w/one",
      }),
      buildPrItem({
        base: { owner: "acme", repo: "widgets-oss", prNumber: 9 },
        githubHost: "github.com",
        prUrl: "https://github.com/acme/widgets-oss/pull/9",
        repoIdentifier: { owner: "acme", repo: "widgets-oss" },
        repoRole: "submodule",
        linkGroupKey: "/w/one",
      }),
    ]);

    // Each side gets its own repo dropdown; the shared link group only decides
    // that the submodule's lands directly beneath its superproject's.
    const headers = await screen.findAllByTestId("pr-repo-group-header");
    expect(headers.map((header) => header.textContent)).toEqual([
      expect.stringContaining("acme/widgets"),
      expect.stringContaining("acme/widgets-oss"),
    ]);
    expect(screen.getByTestId("mock-pr-card-acme/widgets#1")).toBeTruthy();
    expect(screen.getByTestId("mock-pr-card-acme/widgets-oss#9")).toBeTruthy();
  });

  it("a submodule row opens its own pr-detail tile", async () => {
    const epicId = "epic-l2";
    renderPanel({ epicId, tabId: "tab-l2" });
    await emitSnapshot(epicId, [
      buildPrItem({
        base: { owner: "acme", repo: "widgets", prNumber: 1 },
        githubHost: "github.com",
        prUrl: "https://github.com/acme/widgets/pull/1",
        linkGroupKey: "/w/one",
      }),
      buildPrItem({
        base: { owner: "acme", repo: "widgets-oss", prNumber: 9 },
        githubHost: "github.com",
        prUrl: "https://github.com/acme/widgets-oss/pull/9",
        repoIdentifier: { owner: "acme", repo: "widgets-oss" },
        repoRole: "submodule",
        linkGroupKey: "/w/one",
      }),
    ]);

    fireEvent.click(
      await screen.findByTestId("mock-pr-card-acme/widgets-oss#9"),
    );

    const canvasState = useEpicCanvasStore.getState();
    const tabId = Object.keys(canvasState.tabsById).find(
      (id) => canvasState.tabsById[id]?.epicId === epicId,
    );
    expect(tabId).toBeDefined();
    if (tabId === undefined) return;
    const canvas = canvasState.canvasByTabId[tabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected a pane");
    const tile = canvas.tilesByInstanceId[canvas.root.tabInstanceIds[0]];
    if (tile?.type !== "pr-detail")
      throw new Error("expected a pr-detail tile");
    expect(tile.repo).toBe("widgets-oss");
    expect(tile.prNumber).toBe(9);
  });

  it("collapsing a repo header hides its rows and keeps the count visible", async () => {
    const epicId = "epic-c1";
    renderPanel({ epicId, tabId: "tab-c1" });
    await emitSnapshot(epicId, [
      buildPrItem({
        base: { owner: "acme", repo: "widgets", prNumber: 1 },
        githubHost: "github.com",
        prUrl: "https://github.com/acme/widgets/pull/1",
      }),
    ]);

    const header = await screen.findByTestId("pr-repo-group-header");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("mock-pr-card-acme/widgets#1")).toBeNull();
    expect(header.textContent).toContain("1");
  });

  it("clicking a fully-identified card opens a pr-detail tile via the real canvas store", async () => {
    const epicId = "epic-d1";
    const item = buildPrItem({
      base: { owner: "acme", repo: "widgets", prNumber: 55 },
      githubHost: "github.com",
      prUrl: "https://github.com/acme/widgets/pull/55",
      headRefName: "feature/full-view",
      title: "Full view PR",
    });

    renderPanel({ epicId, tabId: "tab-d1" });
    await emitSnapshot(epicId, [item]);

    const card = await screen.findByTestId("mock-pr-card-acme/widgets#55");
    expect(card.getAttribute("data-openable")).toBe("true");
    fireEvent.click(card);

    const expectedTileId: string = prDetailTileId({
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
    // The row advertises the SAME id it opens - that equality is what lets the
    // row light up when its tile is the one showing.
    expect(card.getAttribute("data-tile-id")).toBe(expectedTileId);
  });

  it("an unknown-base card is not openable and clicking it opens no tile", async () => {
    const epicId = "epic-u1";
    renderPanel({ epicId, tabId: "tab-u1" });
    await emitSnapshot(epicId, [
      buildPrItem({ headRefName: "feature/unknown-base" }),
    ]);

    const card = await screen.findByTestId("mock-pr-card-feature/unknown-base");
    expect(card.getAttribute("data-openable")).toBe("false");
    // No tile means nothing to highlight against, ever.
    expect(card.getAttribute("data-tile-id")).toBe("");
    fireEvent.click(card);

    const canvasState = useEpicCanvasStore.getState();
    const tabId = Object.keys(canvasState.tabsById).find(
      (id) => canvasState.tabsById[id]?.epicId === epicId,
    );
    expect(tabId).toBeUndefined();
  });
});
