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

// The tile now offers jump-to-source, so it reaches `useEpicTileNavigation` ->
// `useRouter`. A non-router value is the hook's documented degrade path (it
// falls back to preparing the focus target without navigating), which is all
// these canvas-focused cases need.
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
  // `EpicSessionProvider` folds the host binding's owner identity into its
  // rebuild decision; a null binding is the legitimate "directory not bound
  // yet" state and keeps the identity key null.
  useHostBinding: () => null,
}));

// The epic session and the comm-graph fan-in both build durable transports.
// This stub used to THROW on the reasoning that neither would reach it. Half of
// that reasoning is gone: the session's stream-factory override was deleted, so
// `EpicSessionProvider` now opens a transport unconditionally and the throw
// failed every test here.
//
// The comm-graph half still holds, and by construction rather than by this
// stub: `use-comm-graph-snapshot.ts` builds its opener as
// `localOpenerOverride ?? createCommGraphSubscriptionOpener(openTransport)`, and
// `??` short-circuits - with `__setCommGraphSubscriptionOpenerForTests`
// installed the wrapped opener is never even constructed, let alone invoked.
// What the throw added on top of that was redundancy, and it is what is lost
// here; the primary guarantee is the override, which this file still installs.
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

// The Epic session resolves its host through the selection authority's derived
// pointer (selection model §1), not the active-host projection above - seed the
// decider at its own name (the P1.2 convention in epic-shell-usage-entry-point).
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

// Nodes render `WorktreeOwnerMetadataTooltip` for their hover card, which
// derives PR pills from `pr.subscribeListForEpic` via this hook - unmocked,
// it reaches for `useHostDirectoryEntryForHostId` (absent from the partial
// host-client mock above) and a real stream client, neither of which this
// file provides. This suite is about comm-graph node projection, not PR
// pills, so an inert result suffices.
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
import * as officeAutoModule from "@/lib/comm-graph/office/office-auto";
import { __setCommGraphSubscriptionOpenerForTests } from "@/lib/comm-graph/comm-graph-opener-override";
import type {
  CommGraphSubscriptionHandlers,
  CommGraphSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-subscription";
import {
  commGraphTileId,
  DEFAULT_COMM_GRAPH_VIEW,
  makeCommGraphTileRef,
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
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import type { TileFindAdapter } from "@/stores/tile-find";

const EPIC_ID = "epic-comm-graph";
const CHAT_ID = "chat-1";
const ARCHIVED_CHAT_ID = "chat-archived";
const LEGACY_CHAT_ID = "chat-legacy";
const TUI_ID = "tui-1";
const HOST_A = "host-a";
const HOST_B = "host-b";

const harness = createEpicSessionTestHarness(EPIC_ID);
let queryClient: QueryClient;
const openedByHost = new Map<string, CommGraphSubscriptionHandlers>();
const openRequests: CommGraphSubscriptionRequest[] = [];

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

  const archived = new Y.Map<unknown>();
  archived.set("id", ARCHIVED_CHAT_ID);
  archived.set("title", "Researcher");
  archived.set("parentId", CHAT_ID);
  archived.set("createdAt", 2);
  archived.set("updatedAt", 2);
  archived.set("hostId", HOST_A);
  archived.set("archivedAt", 999);
  archived.set("messages", new Y.Array<unknown>());
  chats.set(ARCHIVED_CHAT_ID, archived);

  // Predates `Chat.hostId` - stays unattributed rather than being guessed at
  // from the app's active host.
  const legacy = new Y.Map<unknown>();
  legacy.set("id", LEGACY_CHAT_ID);
  legacy.set("title", "Legacy");
  legacy.set("parentId", null);
  legacy.set("createdAt", 4);
  legacy.set("updatedAt", 4);
  legacy.set("messages", new Y.Array<unknown>());
  chats.set(LEGACY_CHAT_ID, legacy);

  const tuiAgents = new Y.Map<unknown>();
  const tui = new Y.Map<unknown>();
  tui.set("id", TUI_ID);
  tui.set("harnessId", "claude");
  tui.set("harnessSessionId", "session-1");
  tui.set("agentMode", "regular");
  tui.set("title", "Reviewer");
  tui.set("parentId", CHAT_ID);
  tui.set("createdAt", 3);
  tui.set("updatedAt", 3);
  tui.set("hostId", HOST_B);
  tuiAgents.set(TUI_ID, tui);

  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", tuiAgents);
  epic.set("chats", chats);
}

function seedEmptyDoc(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
}

/**
 * Every case below asserts on React Flow nodes, so the tile is opened in the
 * NODE-GRAPH mode explicitly. The tile's own default is the office floor, which
 * draws to a canvas and mounts no nodes at all.
 */
function graphModeTileRef(): CommGraphTileRef {
  const ref = makeCommGraphTileRef(EPIC_ID);
  return { ...ref, view: { ...ref.view, mode: "graph" } };
}

async function renderTile(): Promise<void> {
  await renderTileWithFindRegistration(undefined);
}

async function renderTileWithFindRegistration(
  onRegister: ((adapter: TileFindAdapter) => void) | undefined,
): Promise<void> {
  const node = graphModeTileRef();
  const tile = <CommGraphTile node={node} viewTabId={EPIC_ID} />;
  render(
    <QueryClientProvider client={queryClient}>
      <TestEpicSessionWrapper epicId={EPIC_ID}>
        {onRegister === undefined ? (
          tile
        ) : (
          <TileFindContext.Provider
            value={{
              tileInstanceId: node.instanceId,
              registerAdapter: (adapter) => {
                onRegister(adapter);
                return () => undefined;
              },
            }}
          >
            {tile}
          </TileFindContext.Provider>
        )}
      </TestEpicSessionWrapper>
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * A controllable stand-in for the real `IntersectionObserver`, the same
 * pattern `comm-graph-office-canvas.test.tsx` uses: jsdom has no
 * implementation of its own, and Auto's probe never fires for an ineligible
 * canvas.
 */
type ObserverEntryLike = { readonly isIntersecting: boolean };
type ObserverCallback = (entries: ReadonlyArray<ObserverEntryLike>) => void;
let activeObserverCallbacks: Array<ObserverCallback> = [];

class ControllableIntersectionObserver {
  private readonly callback: ObserverCallback;
  constructor(callback: ObserverCallback) {
    this.callback = callback;
    activeObserverCallbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    activeObserverCallbacks = activeObserverCallbacks.filter(
      (registered) => registered !== this.callback,
    );
  }
  takeRecords(): ReadonlyArray<ObserverEntryLike> {
    return [];
  }
}

function setIntersecting(value: boolean): void {
  act(() => {
    for (const callback of activeObserverCallbacks) {
      callback([{ isIntersecting: value }]);
    }
  });
}

/** Stubs the office canvas container's measured box and fires the resize path that reads it. */
function setOfficeCanvasSize(size: { width: number; height: number }): void {
  const container = screen.getByTestId("comm-graph-office-canvas");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect(size),
  );
  fireEvent(window, new Event("resize"));
}

const AUTO_TAB_ID = "tab-comm-graph-auto";

/**
 * Auto lives in the TILE, so exercising it needs the tile's own writes to
 * land somewhere readable - which means going through the real canvas store
 * rather than a `node` prop held in local state, the same reason
 * `comm-graph-view-mode-toggle.test.tsx` reads the tile back out of it.
 */
function commGraphTileIn(canvas: EpicCanvasState): CommGraphTileRef | null {
  for (const ref of Object.values(canvas.tilesByInstanceId)) {
    if (ref === undefined) continue;
    if (ref.type === "comm-graph") return ref;
  }
  return null;
}

function storedView(): CommGraphTileViewState | null {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[AUTO_TAB_ID];
  if (canvas === undefined) return null;
  return commGraphTileIn(canvas)?.view ?? null;
}

function TileFromStore() {
  const tile = commGraphTileIn(useEpicCanvas(AUTO_TAB_ID));
  if (tile === null) return null;
  return <CommGraphTile node={tile} viewTabId={AUTO_TAB_ID} />;
}

/**
 * Opens the comm-graph tile through the REAL canvas store, on its own
 * default view (office mode, `officeView: null`, so the effective choice is
 * Settings' default of `"auto"`) - Auto only ever runs in office mode.
 */
async function renderOfficeTile(): Promise<void> {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  const store = useEpicCanvasStore.getState();
  store.openEpicTabWithId(AUTO_TAB_ID, EPIC_ID, undefined);
  store.openTileInTab(AUTO_TAB_ID, makeCommGraphTileRef(EPIC_ID));
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
}

beforeEach(() => {
  openedByHost.clear();
  openRequests.length = 0;
  activeObserverCallbacks = [];
  vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  harness.install(seedDoc, "owner");
  __setCommGraphSubscriptionOpenerForTests((request) => {
    openRequests.push(request);
    openedByHost.set(request.hostId, request.handlers);
    return { close: () => undefined };
  });
});

afterEach(() => {
  __setCommGraphSubscriptionOpenerForTests(null);
  harness.teardown();
  queryClient.clear();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

/**
 * Integrated: real epic projection + real canvas store, with only the stream
 * boundary faked (`__setCommGraphSubscriptionOpenerForTests`).
 *
 * KNOWN jsdom GAP: React Flow renders an edge only after BOTH endpoint nodes
 * have been measured, and jsdom reports every element as 0x0 with a
 * ResizeObserver that never fires - so edges (and their labels) never mount
 * here. Edge behaviour is covered where it actually lives instead:
 * aggregation, counts, last activity and open-thread detection in
 * `lib/comm-graph/__tests__/comm-graph-model.test.ts`, and the click-through
 * message list in `comm-graph-thread-panel.test.tsx`. What is left to the
 * dev-app check is purely the rendered edge itself: that the label shows
 * count + relative last activity, dashes for an open thread, and opens the
 * message list on click.
 */
describe("CommGraphTile", () => {
  it("registers a ready zero-result Find adapter for an empty graph", async () => {
    harness.teardown();
    harness.install(seedEmptyDoc, "owner");
    const registration: { adapter: TileFindAdapter | null } = {
      adapter: null,
    };

    await renderTileWithFindRegistration((adapter) => {
      registration.adapter = adapter;
    });

    await waitFor(() => {
      expect(screen.getByTestId("comm-graph-empty")).toBeDefined();
      expect(registration.adapter).not.toBeNull();
    });
    const registeredAdapter = registration.adapter;
    if (registeredAdapter === null) {
      throw new Error("empty communication graph did not register Find");
    }
    act(() => {
      void registeredAdapter.search({
        requestId: 1,
        query: "agent",
        matchCase: false,
      });
    });
    expect(registeredAdapter.getSnapshot()).toMatchObject({
      requestId: 1,
      status: "ready",
      current: 0,
      total: 0,
      exactHighlight: "none",
    });
  });

  it("subscribes once per host referenced by the epic's agents", async () => {
    await renderTile();

    await waitFor(() => {
      expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]);
    });
    for (const request of openRequests) {
      expect(request.epicId).toBe(EPIC_ID);
      expect(request.sinceCursor).toBeNull();
    }
  });

  it("renders every agent, with archived ones shown and muted", async () => {
    await renderTile();

    await waitFor(() => {
      expect(screen.getByTestId(`comm-graph-node-${CHAT_ID}`)).toBeDefined();
    });
    expect(screen.getByText("Orchestrator")).toBeDefined();
    expect(screen.getByText("Reviewer")).toBeDefined();
    const archived = screen.getByTestId(`comm-graph-node-${ARCHIVED_CHAT_ID}`);
    expect(archived.getAttribute("data-archived")).toBe("true");
    expect(archived.className).toContain("opacity-50");
  });

  it("keeps a legacy chat's host unresolved and captions the node as such", async () => {
    await renderTile();

    await waitFor(() => {
      expect(
        screen.getByTestId(`comm-graph-node-${LEGACY_CHAT_ID}`),
      ).toBeDefined();
    });
    // Rendered, marked, and NOT attributed to the app's active host - which
    // would otherwise move the node (and reset that host's subscription,
    // events and cursor) every time the user switched hosts elsewhere.
    // `host-unknown` is a property of the agent's OWN record (a legacy chat
    // predating `Chat.hostId`), never a subscription status, so it can never
    // reach `snapshot.hosts` and the header's feed-health dot has no way to
    // roll it up - the node is the only place this can ever be surfaced, and
    // it stays captioned here even though the transport statuses do not.
    expect(
      screen
        .getByTestId(`comm-graph-node-${LEGACY_CHAT_ID}`)
        .getAttribute("data-host-status"),
    ).toBe("host-unknown");
    const notice = screen.getByTestId(
      `comm-graph-node-notice-${LEGACY_CHAT_ID}`,
    );
    expect(notice.textContent).toBe("Host unknown");
    // No third subscription: an unresolved host is not a host to dial.
    expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]);
  });

  it("marks agents on a host with no stream method via data-host-status, without captioning the node", async () => {
    await renderTile();
    await waitFor(() => {
      expect(openedByHost.has(HOST_B)).toBe(true);
    });

    act(() => {
      openedByHost.get(HOST_A)?.onStatus("live");
      openedByHost.get(HOST_B)?.onStatus("unsupported");
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`comm-graph-node-${TUI_ID}`)
          .getAttribute("data-host-status"),
      ).toBe("unsupported");
    });
    expect(screen.queryByTestId(`comm-graph-node-notice-${TUI_ID}`)).toBeNull();
    // The other host is unaffected - degrade is per subscription.
    expect(
      screen
        .getByTestId(`comm-graph-node-${CHAT_ID}`)
        .getAttribute("data-host-status"),
    ).not.toBe("unsupported");
  });

  it("marks agents on an unreachable host via data-host-status, without captioning the node", async () => {
    await renderTile();
    await waitFor(() => {
      expect(openedByHost.has(HOST_B)).toBe(true);
    });

    act(() => {
      openedByHost.get(HOST_B)?.onStatus("unreachable");
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`comm-graph-node-${TUI_ID}`)
          .getAttribute("data-host-status"),
      ).toBe("unreachable");
    });
    expect(screen.queryByTestId(`comm-graph-node-notice-${TUI_ID}`)).toBeNull();
  });

  describe("Auto", () => {
    /** Every subscribed host's initial replay done, with no backlog. */
    function markHistoryCaughtUp(): void {
      act(() => {
        openedByHost.get(HOST_A)?.onSnapshot([], null);
        openedByHost.get(HOST_B)?.onSnapshot([], null);
      });
    }

    it("does not run while the snapshot is a partial one", async () => {
      const decideSpy = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });

      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      // Give Auto the same chance to write that the positive case gets - an
      // assertion made the instant after `setOfficeCanvasSize` would pass
      // even if Auto ran on a later tick, since nothing was ever given a
      // chance to prove otherwise.
      await act(async () => {
        await Promise.resolve();
      });

      // Eligible and measured, but `initialHistoryCaughtUp` is still false -
      // neither host's snapshot has been marked complete - so Auto must not
      // have written an outcome, and must not even have MEASURED one.
      expect(storedView()?.officeAutoView).toBeNull();
      expect(decideSpy).not.toHaveBeenCalled();
    });

    it("runs once the inputs are ready, and writes the outcome", async () => {
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      expect(storedView()?.officeAutoView).toBeNull();

      markHistoryCaughtUp();

      await waitFor(() => {
        expect(storedView()?.officeAutoView).not.toBeNull();
      });
      // This fixture's handful of agents fits the Floor comfortably on a
      // 1040x700 tile.
      expect(storedView()?.officeAutoView).toBe("floor");
    });

    it("keeps the saved camera when Auto's first outcome is Floor", async () => {
      // A tile that predates this choice carries a camera framed for the
      // Floor - the view that has always existed - so a first outcome OF
      // Floor is the view that camera already addresses and must survive.
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            {
              x: 111,
              y: 222,
              zoom: 2,
            },
          );
      });

      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      markHistoryCaughtUp();

      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });
      expect(storedView()?.x).toBe(111);
      expect(storedView()?.y).toBe(222);
      expect(storedView()?.zoom).toBe(2);
    });

    it("neutralises the camera when Auto's first outcome is not Floor", async () => {
      // The saved camera was framed for a Floor. Landing on a different view
      // through those same numbers would be a view of empty space, so the
      // patch that writes the outcome resets the camera in the same write.
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            {
              x: 111,
              y: 222,
              zoom: 2,
            },
          );
      });

      setIntersecting(true);
      // Small enough that neither Floor nor Towers reaches office detail on
      // this fixture's agents.
      setOfficeCanvasSize({ width: 120, height: 90 });
      markHistoryCaughtUp();

      await waitFor(() => {
        expect(storedView()?.officeAutoView).not.toBeNull();
      });
      // Asserted directly rather than assumed: if this tiny box lands
      // somewhere other than Building, that is a fact to report, not a box
      // to keep shrinking until it agrees.
      expect(storedView()?.officeAutoView).toBe("building");
      expect(storedView()?.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
      expect(storedView()?.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
      expect(storedView()?.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
    });

    it("does not re-measure on a mode toggle", async () => {
      const decideSpy = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      markHistoryCaughtUp();
      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });
      expect(decideSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      // The measured outcome rides through the round trip untouched, and the
      // gate that guards Auto (`officeAutoView === null`) never opened again -
      // an LRU remount or a mode toggle must not re-decide a floor the user's
      // saved camera already addresses.
      expect(storedView()?.officeAutoView).toBe("floor");
      expect(decideSpy).toHaveBeenCalledTimes(1);
    });

    it("re-measures once officeAutoView is cleared, as a re-pick of Auto clears it", async () => {
      // Driving the picker's own Radix dropdown in jsdom is the less direct
      // route to the same claim: the picker's re-pick writes exactly this -
      // `officeAutoView: null` while `officeView` stays `"auto"` - and this
      // pins the tile's reaction to that write, which is the mechanism the
      // ticket names ("it clears officeAutoView and the next measurement
      // writes it again"), not the dropdown interaction itself.
      const decideSpy = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      markHistoryCaughtUp();
      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });
      expect(decideSpy).toHaveBeenCalledTimes(1);

      const current = storedView();
      if (current === null) throw new Error("expected a stored view");
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileViewInTab(AUTO_TAB_ID, commGraphTileId(EPIC_ID), {
            ...current,
            officeAutoView: null,
          });
      });

      // The cleared outcome resolves `resolvedViewId` to null, which changes
      // the office canvas's `key` and remounts it - a fresh instance with no
      // measured box of its own, so the probe needs feeding again.
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });

      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });
      expect(decideSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("picking a view", () => {
    /** Reaches Auto's resolved Floor, through the real store and the real canvas. */
    async function reachAutoFloor(): Promise<void> {
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      act(() => {
        openedByHost.get(HOST_A)?.onSnapshot([], null);
        openedByHost.get(HOST_B)?.onSnapshot([], null);
      });
      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });
    }

    /** Radix opens on pointerdown, not click - a bare click leaves the menu shut. */
    function openPicker(): void {
      fireEvent.pointerDown(
        screen.getByTestId("comm-graph-office-view-picker"),
        {
          button: 0,
          ctrlKey: false,
          pointerType: "mouse",
        },
      );
    }

    it("picking the already-resolved view records the choice without moving the camera", async () => {
      // `handleOfficeViewChange` used to compare `next` against the STORED
      // `officeView`, which is null on a tile still following Auto - so
      // picking the view already on screen fell through to the camera reset
      // and threw the person's framing away. It now compares against the
      // RESOLVED view.
      await reachAutoFloor();
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            {
              x: 55,
              y: 66,
              zoom: 3,
            },
          );
      });

      openPicker();
      fireEvent.click(screen.getByTestId("comm-graph-office-view-floor"));

      // The pick is still recorded - that is what pins the tile against a
      // later Settings default change - but the camera survives untouched.
      expect(storedView()?.officeView).toBe("floor");
      expect(storedView()?.x).toBe(55);
      expect(storedView()?.y).toBe(66);
      expect(storedView()?.zoom).toBe(3);
    });

    it("picking a different view records the choice and resets the camera", async () => {
      await reachAutoFloor();
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            {
              x: 55,
              y: 66,
              zoom: 3,
            },
          );
      });

      openPicker();
      fireEvent.click(screen.getByTestId("comm-graph-office-view-towers"));

      expect(storedView()?.officeView).toBe("towers");
      expect(storedView()?.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
      expect(storedView()?.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
      expect(storedView()?.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
    });
  });
});
