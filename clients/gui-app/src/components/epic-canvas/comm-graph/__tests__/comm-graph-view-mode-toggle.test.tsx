const useHostNotificationIndicatorsMock = vi.hoisted(() =>
  vi.fn(() => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  })),
);
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: useHostNotificationIndicatorsMock,
}));

// The tile offers jump-to-source, so it reaches `useEpicTileNavigation` ->
// `useRouter`. A non-router value is the hook's documented degrade path.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
}));

const hostDirectoryMock = vi.hoisted(() => ({
  findById: (hostId: string) => ({
    hostId,
    label: hostId,
    kind: "remote" as const,
    websocketUrl: `wss://${hostId}.example/stream`,
    version: "1.0.0",
    transportDialability: "dialable" as const,
  }),
  onChange: () => ({ dispose: () => undefined }),
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostDirectory: () => hostDirectoryMock,
  useHostBinding: () => null,
}));

vi.mock("@/lib/host/use-durable-stream-transport", async () => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => ({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CommGraphTile } from "@/components/epic-canvas/renderers/comm-graph-tile";
import { __setCommGraphSubscriptionOpenerForTests } from "@/lib/comm-graph/comm-graph-opener-override";
import {
  commGraphTileId,
  makeCommGraphTileRef,
  DEFAULT_COMM_GRAPH_VIEW,
} from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type {
  CommGraphTileRef,
  CommGraphTileViewState,
  EpicCanvasState,
} from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicCanvas } from "@/stores/epics/canvas/canvas-selectors";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";

const EPIC_ID = "epic-comm-graph-mode";
const TAB_ID = "tab-comm-graph-mode";
const CHAT_ID = "chat-1";
const HOST_A = "host-a";

const harness = createEpicSessionTestHarness(EPIC_ID);
let queryClient: QueryClient;

function seedDoc(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ID);
  chat.set("title", "Orchestrator");
  chat.set("parentId", null);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  chat.set("hostId", HOST_A);
  chat.set("messages", new Y.Array<unknown>());
  chats.set(CHAT_ID, chat);

  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
}

/**
 * The tile is read back out of the REAL canvas store rather than held in local
 * state, so a toggle only reaches the screen by way of the persisted view -
 * which is the whole claim under test.
 */
function TileFromStore() {
  const tile = commGraphTileIn(useEpicCanvas(TAB_ID));
  if (tile === null) return null;
  return <CommGraphTile node={tile} viewTabId={TAB_ID} />;
}

async function renderTile(): Promise<void> {
  render(
    <QueryClientProvider client={queryClient}>
      <TestEpicSessionWrapper epicId={EPIC_ID}>
        <TileFromStore />
      </TestEpicSessionWrapper>
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  // The epic projection lands a tick after mount, and until it does the tile is
  // legitimately the empty state - which renders neither canvas.
  await waitFor(() => {
    expect(screen.queryByTestId("comm-graph-empty")).toBeNull();
  });
}

/**
 * The tab's comm-graph tile, narrowed once. The store's tile map is keyed by
 * instance id and its values are optional, so both readers below go through
 * here rather than each re-deciding what a missing entry means.
 */
function commGraphTileIn(canvas: EpicCanvasState): CommGraphTileRef | null {
  for (const ref of Object.values(canvas.tilesByInstanceId)) {
    if (ref === undefined) continue;
    if (ref.type === "comm-graph") return ref;
  }
  return null;
}

function storedView(): CommGraphTileViewState | null {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
  if (canvas === undefined) return null;
  return commGraphTileIn(canvas)?.view ?? null;
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  harness.install(seedDoc, "owner");
  __setCommGraphSubscriptionOpenerForTests(() => ({
    close: () => undefined,
  }));
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  const store = useEpicCanvasStore.getState();
  store.openEpicTabWithId(TAB_ID, EPIC_ID, undefined);
  store.openTileInTab(TAB_ID, makeCommGraphTileRef(EPIC_ID));
});

afterEach(() => {
  __setCommGraphSubscriptionOpenerForTests(null);
  harness.teardown();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  queryClient.clear();
  cleanup();
});

describe("comm-graph view mode", () => {
  it("opens on the office floor", async () => {
    await renderTile();

    expect(screen.getByTestId("comm-graph-office-canvas")).toBeDefined();
    expect(screen.queryByTestId("comm-graph-canvas")).toBeNull();
    // The way back is visible from the mode you are in, not only from the
    // other one.
    expect(screen.getByTestId("comm-graph-mode-graph")).toBeDefined();
  });

  it("switches to the node graph and persists the choice on the tile", async () => {
    await renderTile();

    await act(async () => {
      fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
      await Promise.resolve();
    });

    expect(storedView()?.mode).toBe("graph");
    expect(screen.getByTestId("comm-graph-canvas")).toBeDefined();
    expect(screen.queryByTestId("comm-graph-office-canvas")).toBeNull();
  });

  it("resets the viewport on a mode switch so the incoming mode fits itself", async () => {
    // Sprite pixels and flow units are not the same measure, so a framing made
    // in one mode would land the other off-screen while still counting as
    // "the user framed this" and suppressing its fit.
    act(() => {
      useEpicCanvasStore
        .getState()
        .updateCommGraphTileViewInTab(TAB_ID, commGraphTileId(EPIC_ID), {
          x: 400,
          y: -220,
          zoom: 3,
          mode: "office",
        });
    });
    await renderTile();

    await act(async () => {
      fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
      await Promise.resolve();
    });

    expect(storedView()).toEqual({ ...DEFAULT_COMM_GRAPH_VIEW, mode: "graph" });
  });

  it("switches back to the office from the graph", async () => {
    await renderTile();

    await act(async () => {
      fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
      await Promise.resolve();
    });

    expect(storedView()?.mode).toBe("office");
    expect(screen.getByTestId("comm-graph-office-canvas")).toBeDefined();
  });

  it("floats the toggle inside the canvas area, not over the whole tile", async () => {
    await renderTile();

    // Containment, not coordinates: a detail panel is the canvas's SIBLING and
    // puts its close button at its own top-right, so a toggle anchored to the
    // tile would sit on top of that button whenever a panel is open.
    expect(
      screen
        .getByTestId("comm-graph-office-canvas")
        .contains(screen.getByTestId("comm-graph-mode-toggle")),
    ).toBe(true);
  });

  it("marks the live mode as pressed", async () => {
    await renderTile();

    expect(
      screen.getByTestId("comm-graph-mode-office").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("comm-graph-mode-graph").getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
