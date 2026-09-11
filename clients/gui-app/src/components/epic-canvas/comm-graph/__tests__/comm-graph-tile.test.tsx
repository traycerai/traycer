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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as Y from "yjs";
import { CommGraphTile } from "@/components/epic-canvas/renderers/comm-graph-tile";
import * as commGraphCanvasModule from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import * as officeCanvasModule from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import * as officeAutoModule from "@/lib/comm-graph/office/office-auto";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";
import { OFFICE_BENCH_SEED } from "@/components/epic-canvas/comm-graph/office/office-bench";
import {
  OFFICE_VIEWS,
  OFFICE_VIEW_IDS,
} from "@/lib/comm-graph/office/views/office-view";
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
  OfficeViewChoice,
} from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicCanvas } from "@/stores/epics/canvas/canvas-selectors";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import type { TileFindAdapter } from "@/stores/tile-find";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { OfficeRect } from "@/lib/comm-graph/office/office-types";
import { useCommGraphAgents } from "@/components/epic-canvas/comm-graph/use-comm-graph-agents";
import { __resetCommGraphRegistryForTests } from "@/lib/comm-graph/comm-graph-registry";

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

/** Radix opens on pointerdown, not click - a bare click leaves the menu shut. */
function openPicker(): void {
  fireEvent.pointerDown(screen.getByTestId("comm-graph-office-view-picker"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

/**
 * Reaches Auto's resolved Floor, through the real store and the real canvas:
 * the state every pick below starts from.
 */
async function reachAutoFloor(): Promise<void> {
  await renderOfficeTile();
  await waitFor(() => {
    expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]);
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

/**
 * Picks a view through the REAL picker - the dropdown a person opens and the
 * radio item they click - and settles the canvas that results.
 *
 * Shared by the switch cases and the bench, which both need a scene in hand:
 * a pick is what puts one there, the view Auto already chose included.
 */
async function pickView(viewId: OfficeViewId): Promise<void> {
  openPicker();
  await act(async () => {
    fireEvent.click(screen.getByTestId(`comm-graph-office-view-${viewId}`));
    await Promise.resolve();
  });
  setIntersecting(true);
  setOfficeCanvasSize({ width: 1040, height: 700 });
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Picks a choice through the REAL picker without settling a scene afterwards
 * - the synchronous half of `pickView` above, for cases that need to inspect
 * what the pick's own write did BEFORE anything else runs. Takes the full
 * `OfficeViewChoice` (Auto included) because the picker's Auto row shares the
 * same `comm-graph-office-view-<id>` naming as a concrete view's row.
 */
function chooseView(choice: OfficeViewChoice): void {
  openPicker();
  fireEvent.click(screen.getByTestId(`comm-graph-office-view-${choice}`));
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
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

/**
 * Opens the tile on a PERSISTED view - round-tripped through the real
 * serializer, the same way a reload would hand it back - rather than a
 * literal passed straight to the store. `officeView`/`officeAutoView`
 * restoration is a parse-time concern, and a literal would skip exactly the
 * path these cases are about.
 */
async function renderSeededOffice(view: CommGraphTileViewState): Promise<void> {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  const store = useEpicCanvasStore.getState();
  store.openEpicTabWithId(AUTO_TAB_ID, EPIC_ID, undefined);
  const ref = makeCommGraphTileRef(EPIC_ID);
  const restored = parseTileRef(serializeTileRef({ ...ref, view }));
  if (restored === null || restored.type !== "comm-graph") {
    throw new Error("failed tile restore");
  }
  store.openTileInTab(AUTO_TAB_ID, restored);
  render(
    <QueryClientProvider client={queryClient}>
      <TestEpicSessionWrapper epicId={EPIC_ID}>
        <TileFromStore />
      </TestEpicSessionWrapper>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]),
  );
}

function caughtUp(): void {
  act(() => {
    openedByHost.get(HOST_A)?.onSnapshot([], null);
    openedByHost.get(HOST_B)?.onSnapshot([], null);
  });
}

/**
 * A real 2d context (recording nothing usable, but not throwing) plus a
 * controllable `requestAnimationFrame`, so the frame loop actually RUNS in
 * jsdom instead of being gated off by `get2dContext`'s null. Ported from
 * `comm-graph-office-canvas.test.tsx`'s helper of the same purpose: the R1
 * regression is about what the RUNTIME actually framed on its first frame,
 * not merely what the store says, so the loop has to run for real.
 */
function installCanvas(): { readonly step: () => void } {
  const noop = () => undefined;
  // Typed at the proxy's SOURCE rather than asserted onto afterwards: a
  // literal carrying three of this interface's hundred-odd members does not
  // overlap it enough for a single assertion, and widening through `unknown`
  // is what the type rules forbid. Anything the painter reaches for that is
  // not answered here is a no-op.
  const blank = {} as CanvasRenderingContext2D;
  const context = new Proxy(blank, {
    get: (_target, key): unknown => {
      if (key === "measureText") {
        return (text: string) => ({ width: text.length * 6 });
      }
      if (key === "createImageData") {
        return (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        });
      }
      return noop;
    },
    set: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 1040, 700),
  );
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextId += 1;
    callbacks.set(nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  let now = performance.now();
  return {
    step: () =>
      act(() => {
        now += 100;
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback(now);
      }),
  };
}

/**
 * What a `vi.spyOn` actually recorded, read back through a type guard.
 *
 * A spy's `calls`/`contexts` are `any`, and lint refuses a field read off
 * one - narrowing at this boundary is the route that works (see
 * `comm-graph-office-canvas.test.tsx`'s `isOfficeRect`/`lastFramedRect`,
 * which this mirrors).
 */
interface SpiedCalls {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}
interface SpiedContexts {
  readonly mock: { readonly contexts: ReadonlyArray<unknown> };
}

function isOfficeRect(value: unknown): value is OfficeRect {
  if (typeof value !== "object" || value === null) return false;
  if (!("x" in value && "y" in value)) return false;
  if (!("width" in value && "height" in value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

interface TileCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

function isTileCamera(value: unknown): value is TileCamera {
  if (typeof value !== "object" || value === null) return false;
  if (!("x" in value && "y" in value && "zoom" in value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.zoom === "number"
  );
}

/** The `view` prop most recently handed to a spied-on canvas component. */
function lastCanvasCamera(spy: SpiedCalls): TileCamera | null {
  const props = spy.mock.calls.at(-1)?.[0];
  if (typeof props !== "object" || props === null || !("view" in props)) {
    return null;
  }
  return isTileCamera(props.view) ? props.view : null;
}

/**
 * The most recent real frame the runtime drew, and the bounds of the view it
 * drew - both from the ACTUAL scene, not the store. R1 is exactly the gap
 * between what the store says and what the runtime already framed on its
 * first frame, so this is the reading that can tell the two apart.
 */
function lastFrameAndBounds(
  frames: SpiedCalls,
  sync: SpiedContexts,
): { readonly frame: OfficeRect; readonly bounds: OfficeRect } {
  const frame = frames.mock.calls.at(-1)?.[1];
  const scene = sync.mock.contexts.at(-1);
  if (!isOfficeRect(frame) || !(scene instanceof OfficeScene)) {
    throw new Error("no real scene frame");
  }
  const layout = scene.layout();
  if (layout === null) throw new Error("no layout");
  return {
    frame,
    bounds: OFFICE_VIEWS[layout.view].painter.projector(layout).bounds,
  };
}

/**
 * Gates the tile behind the epic's own agent load, so a mount that should
 * witness a Settings change actually has agents by the time its effects
 * run. A cold mount (agents still empty on the first render) can mask R1's
 * "unmounted" reproduction entirely - the effect that resets the camera
 * closes over an empty `node.view` update cycle no differently, but the
 * render-time decision this fixup added reads `agents.length` nowhere, so
 * the real risk is a probe that never reaches a truthful `inputsReady`
 * because the office canvas measured before agents existed. Loading first is
 * what the reviewer's own probe does to rule that out.
 */
function LoadedTileGate(props: { readonly show: boolean }) {
  const { nodes } = useCommGraphAgents();
  return (
    <>
      <div data-testid="loaded-agent-count">{nodes.length}</div>
      {props.show ? <TileFromStore /> : null}
    </>
  );
}

async function renderSeededOfficeInLoadedSession(
  view: CommGraphTileViewState,
): Promise<void> {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  const store = useEpicCanvasStore.getState();
  store.openEpicTabWithId(AUTO_TAB_ID, EPIC_ID, undefined);
  const ref = makeCommGraphTileRef(EPIC_ID);
  const restored = parseTileRef(serializeTileRef({ ...ref, view }));
  if (restored === null || restored.type !== "comm-graph") {
    throw new Error("failed tile restore");
  }
  store.openTileInTab(AUTO_TAB_ID, restored);
  const element = (show: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TestEpicSessionWrapper epicId={EPIC_ID}>
        <LoadedTileGate show={show} />
      </TestEpicSessionWrapper>
    </QueryClientProvider>
  );
  const mount = render(element(false));
  await waitFor(() =>
    expect(screen.getByTestId("loaded-agent-count").textContent).toBe("4"),
  );
  mount.rerender(element(true));
  await waitFor(() =>
    expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]),
  );
}

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

    it("writes nothing when replay finishes after the tile became hidden mid-measurement", async () => {
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 120, height: 90 });
      expect(decide).not.toHaveBeenCalled();

      // Hidden BEFORE the replay that would have completed the inputs -
      // the probe the canvas reported is withdrawn, so a decision has
      // nothing to measure with even once history catches up.
      setIntersecting(false);
      markHistoryCaughtUp();

      expect(decide).not.toHaveBeenCalled();
      expect(storedView()?.officeAutoView).toBeNull();
    });

    it("does not decide or touch the graph camera when replay finishes after leaving office", async () => {
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 120, height: 90 });
      fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            { x: 155, y: 266, zoom: 2 },
          );
      });
      expect(storedView()?.mode).toBe("graph");

      markHistoryCaughtUp();

      expect(decide).not.toHaveBeenCalled();
      expect(storedView()).toMatchObject({
        mode: "graph",
        x: 155,
        y: 266,
        zoom: 2,
        officeAutoView: null,
      });
    });

    it("waits for the new canvas box when Auto is re-picked while the tile has shrunk", async () => {
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

      // The tile shrinks (a detail panel opened, say) before Auto is asked
      // again - this stale box must never be the one a re-pick decides from.
      setOfficeCanvasSize({ width: 120, height: 90 });
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      fireEvent.pointerDown(
        screen.getByTestId("comm-graph-office-view-picker"),
        { button: 0, ctrlKey: false, pointerType: "mouse" },
      );
      fireEvent.click(screen.getByTestId("comm-graph-office-view-auto"));

      expect(decide).not.toHaveBeenCalled();

      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });

      await waitFor(() => expect(decide).toHaveBeenCalled());
      expect(decide.mock.calls[0]?.[1]).toEqual({ width: 1040, height: 700 });
      expect(storedView()?.officeAutoView).toBe("floor");
    });
  });

  describe("Settings default view", () => {
    it("resets a followed default camera when Settings changes the resolved view", async () => {
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
      });
      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Floor");

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Towers");
      expect(storedView()).toMatchObject({
        x: 0,
        y: 0,
        zoom: 1,
        officeView: null,
      });
    });

    it("leaves an explicitly picked tile unchanged when Settings default changes", async () => {
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "city",
        x: 25,
        y: 40,
        zoom: 2,
      });
      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("City");

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("City");
      expect(storedView()).toMatchObject({
        officeView: "city",
        x: 25,
        y: 40,
        zoom: 2,
      });
    });

    it("moves nothing when a default change resolves to the same view", async () => {
      // Started on Auto with a restored Floor outcome, so the default's
      // OWN change - from "auto" to the concrete "floor" - still resolves
      // to the same view the camera was framed for.
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: 5,
        y: 6,
        zoom: 2,
        officeAutoView: "floor",
      });

      act(() => useSettingsStore.getState().setAgentOfficeDefaultView("floor"));

      expect(storedView()).toMatchObject({ x: 5, y: 6, zoom: 2 });
    });
  });

  describe("persisted camera record (officeCameraView)", () => {
    it("resets the camera on mount when the record disagrees with the resolved view", async () => {
      // The default moved while this tile was CLOSED - nothing mounted to
      // witness the change, so the only evidence is the record the camera
      // itself carries.
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "floor",
      });

      await waitFor(() =>
        expect(
          screen.getByTestId("comm-graph-office-view-picker").textContent,
        ).toBe("Towers"),
      );
      expect(storedView()).toMatchObject({
        x: 0,
        y: 0,
        zoom: 1,
        officeCameraView: "towers",
      });
    });

    it("leaves the camera untouched on mount when the record already matches the resolved view", async () => {
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "floor",
      });

      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "floor",
      });
    });

    it("writes the resolved view into the record when the office camera actually pans", async () => {
      // The read-side cases above all pass even if the write side never
      // fires a non-null value - this is the one that makes the field real:
      // a pan through the office's OWN camera path must land the view it
      // panned, not merely leave whatever was already there.
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

      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 80,
        deltaY: 90,
      });
      // The write is debounced (150ms); real time, since this suite runs no
      // fake timers.
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      });

      expect(storedView()?.officeCameraView).toBe("floor");
    });
  });

  describe("actual runtime camera on a default change (fixup 2, R1)", () => {
    // The store's own reset used to run in an EFFECT, which is one commit too
    // late: the replacement canvas already built its one-time runtime from
    // the OLD camera on its first render, framing far outside the new view's
    // world. The store said neutral while the runtime kept the stale
    // framing, and the next wheel gesture persisted THAT, stamped with the
    // new view. Asserting the store alone is exactly what let this through -
    // every case below reads the real scene's frame instead.
    it.each(["mounted", "unmounted"] as const)(
      "resets the actual runtime camera for a %s default change",
      async (kind) => {
        const { step } = installCanvas();
        const frames = vi.spyOn(OfficeScene.prototype, "frame");
        const sync = vi.spyOn(OfficeScene.prototype, "sync");
        useSettingsStore
          .getState()
          .setAgentOfficeDefaultView(kind === "mounted" ? "floor" : "towers");
        await renderSeededOfficeInLoadedSession({
          ...DEFAULT_COMM_GRAPH_VIEW,
          x: -10000,
          y: -20000,
          zoom: 4,
          officeCameraView: "floor",
        });
        setOfficeCanvasSize({ width: 1040, height: 700 });
        setIntersecting(true);
        caughtUp();
        step();
        if (kind === "mounted") {
          // The default moves WHILE this tile watches - the case the effect
          // itself witnesses.
          act(() =>
            useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
          );
          setOfficeCanvasSize({ width: 1040, height: 700 });
          setIntersecting(true);
          step();
        }
        // "unmounted" needs no further action: the tile mounted AFTER the
        // default already moved, so the record disagreeing at render is the
        // only evidence there ever was.

        const cameraBeforePan = storedView();
        expect(cameraBeforePan).toMatchObject({
          x: 0,
          y: 0,
          zoom: 1,
          officeCameraView: "towers",
        });
        // The ACTUAL claim: the runtime's own frame, built from whatever
        // camera the replacement canvas actually started with, has to
        // contain the Towers world it is supposedly showing - not a Floor
        // camera's numbers reinterpreted as Towers.
        const state = lastFrameAndBounds(frames, sync);
        const center = {
          x: state.bounds.x + state.bounds.width / 2,
          y: state.bounds.y + state.bounds.height / 2,
        };
        expect(center.x).toBeGreaterThanOrEqual(state.frame.x);
        expect(center.x).toBeLessThanOrEqual(state.frame.x + state.frame.width);
        expect(center.y).toBeGreaterThanOrEqual(state.frame.y);
        expect(center.y).toBeLessThanOrEqual(
          state.frame.y + state.frame.height,
        );

        // A wheel from here has to land somewhere - the write side must not
        // throw or silently drop, now that the runtime actually started
        // neutral rather than carrying the stale Floor framing forward.
        fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
          deltaX: 20,
          deltaY: 30,
        });
        step();
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 180));
        });
        expect(storedView()?.officeCameraView).toBe("towers");
      },
    );

    it("preserves the actual runtime camera when the stored view and unchanged default agree", async () => {
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "floor",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "floor",
      });
      // The runtime kept the persisted framing too - a control against the
      // case above, proving the render-time decision only intervenes when
      // the record actually disagrees.
      expect(state.frame).toEqual({
        x: 2500,
        y: 5000,
        width: 260,
        height: 175,
      });
    });
  });

  describe("actual runtime camera on a live default change with no record (fixup 3, R1)", () => {
    // The record above (`officeCameraView`) is the only evidence available
    // at render for a tile that was already OPEN when the default moved -
    // but a camera persisted before that field existed carries `null`, and
    // `null` reads as "nobody framed this, keep it". That is correct for a
    // tile merely reopened, and WRONG for a tile watching the default move
    // right now: nothing in the record says a move was witnessed, so
    // without a second signal the render-time decision above has nothing
    // to catch this on. `useWitnessedOfficeViewMove` is that signal - a
    // render-phase state adjustment, not an effect, because `createOfficeRuntime`
    // reads x/y/zoom exactly once at construction and an effect's write
    // always lands one commit after the canvas that needed it.
    it("resets the actual runtime camera for a live default change with no framing record at all", async () => {
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        // A camera from before this field existed - never framed a view.
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      // Not yet reset: nothing has moved, so the persisted framing survives
      // exactly as a legacy tile's should.
      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      const beforeElement = screen.getByTestId("comm-graph-office-canvas");

      // The default moves WHILE this tile watches - the one signal the
      // record alone could never carry.
      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      step();

      // A genuinely different view is a genuinely different canvas
      // instance, same as every other reset in this ticket.
      expect(screen.getByTestId("comm-graph-office-canvas")).not.toBe(
        beforeElement,
      );
      expect(storedView()).toMatchObject({
        x: 0,
        y: 0,
        zoom: 1,
        officeCameraView: "towers",
      });
      // The ACTUAL claim: the runtime's own frame has to contain the
      // Towers world it is supposedly showing - not a Floor camera's
      // numbers reinterpreted as Towers, which is exactly what a witness
      // that never fired would have let through.
      const state = lastFrameAndBounds(frames, sync);
      const center = {
        x: state.bounds.x + state.bounds.width / 2,
        y: state.bounds.y + state.bounds.height / 2,
      };
      expect(center.x).toBeGreaterThanOrEqual(state.frame.x);
      expect(center.x).toBeLessThanOrEqual(state.frame.x + state.frame.width);
      expect(center.y).toBeGreaterThanOrEqual(state.frame.y);
      expect(center.y).toBeLessThanOrEqual(state.frame.y + state.frame.height);

      // And the write side agrees: a wheel from here persists coordinates
      // relative to the NEUTRAL camera the runtime actually started from,
      // not the stale Floor framing carried forward and re-stamped Towers.
      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 20,
        deltaY: 30,
      });
      step();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      });
      expect(storedView()).toMatchObject({ officeCameraView: "towers" });
      expect(storedView()?.x).not.toBe(-10020);
      expect(storedView()?.y).not.toBe(-20030);
    });

    it("does not fire when the default never moves, even with no framing record", async () => {
      // The control against the case above: a witness with nothing to
      // report must not manufacture a reset on its own. `officeCameraView`
      // staying null (not stamped to the resolved view) is the tell - a
      // store-side stamp instead of a render-phase witness would have
      // written a fabricated record here even though nothing moved.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      expect(state.frame).toEqual({
        x: 2500,
        y: 5000,
        width: 260,
        height: 175,
      });
    });

    it("keeps a legacy camera when the default already moved before the tile ever mounted (accepted gap, D52)", async () => {
      // Nothing witnessed this move - the default was already `towers` by
      // the time this tile opened, so there is no live change for
      // `useWitnessedOfficeViewMove` to catch, and no record to catch it at
      // render either. Resetting here would throw away the framing of
      // EVERY tile saved before `officeCameraView` existed the instant
      // Settings' default happened to differ from what they were framed
      // for - the worse of the two costs, and the one D52 accepted.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      expect(state.frame).toEqual({
        x: 2500,
        y: 5000,
        width: 260,
        height: 175,
      });
    });

    it("stops overriding the camera it hands the canvas once the reset has landed", async () => {
      // `useWitnessedOfficeViewMove` clears `owed` at render, once the
      // store's record catches up with the resolved view. Without that
      // clear the latch never lets go: the tile keeps handing the canvas a
      // neutral camera long after the person has panned away from it.
      //
      // That defect is invisible in the SCENE'S OWN frame, which is why
      // none of the cases above would catch it: `createOfficeRuntime` reads
      // x/y/zoom exactly once at construction, so a canvas that is not
      // remounted never re-reads the prop and a stale override never
      // reaches a rendered frame. It is only visible one layer up, at the
      // prop boundary itself - so this reads what the canvas was actually
      // GIVEN on its most recent render, not what it drew.
      const { step } = installCanvas();
      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      step();

      // The pan that follows the reset - the moment `owed` has to have let
      // go by, or this camera stays neutral forever no matter where the
      // person pans to.
      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 20,
        deltaY: 30,
      });
      step();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      });

      const handedCamera = lastCanvasCamera(office);
      if (handedCamera === null) {
        throw new Error("the office canvas never rendered with a view prop");
      }
      const stored = storedView();
      if (stored === null) throw new Error("no stored view");
      // The comparison below only means something if the store actually
      // moved off neutral - otherwise a wheel that silently became a no-op
      // would still pass, since a neutral `handedCamera` and a neutral
      // `stored` agree trivially. This is what stops that from happening
      // unnoticed; it doesn't pin exact coordinates, same reasoning as case 1.
      expect(stored).not.toMatchObject({ x: 0, y: 0, zoom: 1 });
      expect(handedCamera).toMatchObject({
        x: stored.x,
        y: stored.y,
        zoom: stored.zoom,
      });
    });
  });

  describe("a Settings change under an unresolved Auto (fixup 4, R1)", () => {
    // Fixup 3's witness armed on the SHAPE of the move: any `null` on
    // either side, or a record that already disagreed with the arriving
    // view. Both readings were wrong about the one writer that matters
    // here. `resolvedViewId` is also `null` when the Settings default is
    // Auto and replay has not produced a measurement yet - and from
    // there, a Settings change to a CONCRETE view moves the resolved view
    // with no atomic write behind it at all, exactly like a live default
    // change moves it. The witness sat that transition out because it
    // starts and ends on `null` on one side, so the reset only happened in
    // the later default-change effect, a frame after the replacement
    // runtime had already captured the stale camera.
    //
    // It also failed when the record ALREADY named the arriving view - a
    // tile saved under a Settings default of Towers, reopened while the
    // default is Auto, then Settings -> Towers again - because a record
    // can name a view for reasons that have nothing to do with a writer
    // having just run. So the rule cannot read the VALUE at all; it has
    // to read WHICH WRITER moved the resolved view. What arms the witness
    // now is the Settings default changing between one render and the
    // next; Auto's answer, a re-pick of Auto and an explicit pick each
    // write their own camera in the same store write, so none of them
    // arm it.

    // The per-epic comm-graph subscription manager is retained (a bounded
    // MRU, not per-test) across every case in this file, keyed on
    // `EPIC_ID` - so a manager an EARLIER case already caught up for this
    // epic survives into a later one and answers `initialHistoryCaughtUp`
    // before this describe's own `caughtUp()` ever runs. Every case here
    // depends on catching that transition mid-flight, so each gets a fresh
    // manager rather than inheriting whatever state the file's run order
    // left behind.
    beforeEach(() => {
      __resetCommGraphRegistryForTests();
    });

    it.each(["towers", "campus"] as const)(
      "resets the runtime camera when Settings moves from an unresolved Auto to %s",
      async (target) => {
        const { step } = installCanvas();
        const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
        const frames = vi.spyOn(OfficeScene.prototype, "frame");
        const sync = vi.spyOn(OfficeScene.prototype, "sync");
        useSettingsStore.getState().setAgentOfficeDefaultView("auto");
        await renderSeededOfficeInLoadedSession({
          ...DEFAULT_COMM_GRAPH_VIEW,
          x: -10000,
          y: -20000,
          zoom: 4,
          officeCameraView: null,
        });
        setOfficeCanvasSize({ width: 1040, height: 700 });
        setIntersecting(true);
        // Replay still pending - Auto has nothing to decide from, which is
        // what keeps the resolved view at `null` here.
        expect(decide).not.toHaveBeenCalled();
        expect(storedView()).toMatchObject({
          x: -10000,
          y: -20000,
          zoom: 4,
          officeCameraView: null,
        });

        act(() =>
          useSettingsStore.getState().setAgentOfficeDefaultView(target),
        );
        setOfficeCanvasSize({ width: 1040, height: 700 });
        setIntersecting(true);
        caughtUp();
        step();

        // The default is concrete now, so Auto still never runs - there was
        // never a measurement for it to make.
        expect(decide).not.toHaveBeenCalled();
        expect(storedView()).toMatchObject({
          x: 0,
          y: 0,
          zoom: 1,
          officeCameraView: target,
        });
        const state = lastFrameAndBounds(frames, sync);
        const center = {
          x: state.bounds.x + state.bounds.width / 2,
          y: state.bounds.y + state.bounds.height / 2,
        };
        expect(center.x).toBeGreaterThanOrEqual(state.frame.x);
        expect(center.x).toBeLessThanOrEqual(state.frame.x + state.frame.width);
        expect(center.y).toBeGreaterThanOrEqual(state.frame.y);
        expect(center.y).toBeLessThanOrEqual(
          state.frame.y + state.frame.height,
        );

        fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
          deltaX: 20,
          deltaY: 30,
        });
        step();
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 180));
        });
        expect(storedView()).toMatchObject({ officeCameraView: target });
        expect(storedView()?.x).not.toBe(-10020);
        expect(storedView()?.y).not.toBe(-20030);
      },
    );

    it("resets the runtime camera even when the record already names the arriving view", async () => {
      // The record alone was never enough to answer this: it can already
      // read "towers" from before the tile was ever reopened, over a
      // camera nothing has reframed since. The record describes where the
      // camera has BEEN; only the witness can say a writer has framed it
      // FOR the view arriving now. This is the case that rules out "record
      // !== resolvedView" as the trigger - a rule keyed on the value alone
      // would have waved this one through.
      const { step } = installCanvas();
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "towers",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      expect(decide).not.toHaveBeenCalled();
      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: "towers",
      });

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      expect(decide).not.toHaveBeenCalled();
      expect(storedView()).toMatchObject({
        x: 0,
        y: 0,
        zoom: 1,
        officeCameraView: "towers",
      });
      const state = lastFrameAndBounds(frames, sync);
      const center = {
        x: state.bounds.x + state.bounds.width / 2,
        y: state.bounds.y + state.bounds.height / 2,
      };
      expect(center.x).toBeGreaterThanOrEqual(state.frame.x);
      expect(center.x).toBeLessThanOrEqual(state.frame.x + state.frame.width);
      expect(center.y).toBeGreaterThanOrEqual(state.frame.y);
      expect(center.y).toBeLessThanOrEqual(state.frame.y + state.frame.height);

      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 20,
        deltaY: 30,
      });
      step();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      });
      expect(storedView()).toMatchObject({ officeCameraView: "towers" });
      expect(storedView()?.x).not.toBe(-10020);
      expect(storedView()?.y).not.toBe(-20030);
    });

    it("leaves an explicit pick's own reset alone - the pick's write did it, not the witness", async () => {
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });

      chooseView("towers");

      // The pick's own write already reset the camera the store holds -
      // this is a fact about `handleOfficeViewChange`, nothing the witness
      // is even eligible to touch (an explicit pick never arms it).
      expect(storedView()).toMatchObject({
        officeView: "towers",
        officeCameraView: "towers",
        x: 0,
        y: 0,
        zoom: 1,
      });

      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();
      const state = lastFrameAndBounds(frames, sync);
      const center = {
        x: state.bounds.x + state.bounds.width / 2,
        y: state.bounds.y + state.bounds.height / 2,
      };
      expect(center.x).toBeGreaterThanOrEqual(state.frame.x);
      expect(center.x).toBeLessThanOrEqual(state.frame.x + state.frame.width);
      expect(center.y).toBeGreaterThanOrEqual(state.frame.y);
      expect(center.y).toBeLessThanOrEqual(state.frame.y + state.frame.height);
    });

    it("keeps a resolved Floor camera when Auto answers - the witness must not overrule a preserved camera", async () => {
      // Same "no measurement yet" seed as the two defect cases above, but
      // replay is let finish here instead of held back, so Auto answers
      // Floor on its own atomic write. If the witness ever armed on a
      // plain `null -> concrete` move - the over-broad fix this case
      // exists to catch - it would have already thrown this camera away by
      // the time the assertions below run, and the frame would land on the
      // neutral camera's numbers instead of these.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: -10000,
        y: -20000,
        zoom: 4,
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      expect(storedView()).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
        officeAutoView: "floor",
        officeCameraView: "floor",
      });
      // Auto's decision remounts the canvas (measuring -> floor), and that
      // remount only reports its own eligibility on the frame this `step()`
      // drives - the sync loop it then starts needs one more of its own.
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      step();
      const state = lastFrameAndBounds(frames, sync);
      expect(state.frame).toEqual({
        x: 2500,
        y: 5000,
        width: 260,
        height: 175,
      });
    });

    it("neutralises the camera on a re-pick of Auto - the re-pick's own write did it, not the witness", async () => {
      const { step } = installCanvas();
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "floor",
        officeCameraView: "floor",
        x: 155,
        y: 266,
        zoom: 2,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();
      expect(storedView()).toMatchObject({
        officeView: "floor",
        officeCameraView: "floor",
        x: 155,
        y: 266,
        zoom: 2,
      });

      chooseView("auto");

      // The re-pick neutralised the resolved view AND the camera in the
      // same write; the resolved view landing on `null` here is not
      // something the witness gets to act on.
      expect(storedView()).toMatchObject({
        officeView: "auto",
        officeAutoView: null,
        officeCameraView: null,
        x: 0,
        y: 0,
        zoom: 1,
      });
    });
  });

  describe("graph camera untouched by an office default change (fixup 2, R3)", () => {
    it("leaves the active graph camera alone, and Office resumes framing neutral once it is active again", async () => {
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        officeCameraView: null,
      });
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            { x: 155, y: 266, zoom: 2 },
          );
      });

      // The default moves while GRAPH is the active mode - the office has no
      // canvas mounted to reset, and the record disagreeing afterwards must
      // not spill onto the graph's own camera.
      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );

      expect(storedView()).toMatchObject({
        mode: "graph",
        x: 155,
        y: 266,
        zoom: 2,
        officeCameraView: null,
      });

      // Switching back to Office resets the viewport (camera AND the
      // framing record) the same way any mode toggle does - it must not
      // carry the graph's coordinates in as if they were an office camera.
      fireEvent.click(screen.getByTestId("comm-graph-mode-office"));

      expect(storedView()).toMatchObject({
        mode: "office",
        x: 0,
        y: 0,
        zoom: 1,
        officeCameraView: null,
      });
    });

    /**
     * FAILS AGAINST THE CURRENT TREE, unmodified - not a mutation-only
     * probe. `officeViewForCanvas`'s `mode !== "office"` gate (the one the
     * coordinator asked this case to guard) is not the thing that trips it:
     * that gate is intact and does its job for the render-time `view` prop.
     * A SEPARATE effect - "THE CAMERA IS ABOUT A VIEW" in
     * `comm-graph-tile.tsx` (the `resolvedViewId`/`officeCameraView`
     * mismatch writer just above the Auto effect) - has no such gate. It
     * compares `node.view.officeCameraView` against `resolvedViewId`
     * unconditionally, and `resolvedViewId` is computed independent of
     * `node.view.mode` - so a stale office record mismatching the CURRENT
     * office default fires this effect and overwrites the GRAPH's own
     * camera with `NEUTRAL_CAMERA` even while Graph is the active mode and
     * the office canvas is not even mounted. Reported to the coordinator
     * rather than adjusted here - this exact scenario should fail today,
     * and the actual failure is:
     *   expected { x: 0, y: 0, zoom: 1, ... } to match object
     *   { x: 155, y: 266, zoom: 2 }
     */
    it("hands the Graph canvas its own stored camera untouched, even when the office record is stale", async () => {
      const canvasSpy = vi.spyOn(commGraphCanvasModule, "CommGraphCanvas");
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        x: 155,
        y: 266,
        zoom: 2,
        // Stale: framed under Floor while Office (unseen, since Graph is
        // active) now resolves to Towers via the changed default.
        officeCameraView: "floor",
      });

      // Reading what the CANVAS was given, not the store - the store is
      // untouched in the R3 scenario either way, so asserting
      // `storedView()` there is the right read; here it is NOT untouched,
      // which is exactly the finding above.
      const camera = lastCanvasCamera(canvasSpy);
      if (camera === null) {
        throw new Error("no camera prop was passed to the Graph canvas");
      }
      expect(camera).toMatchObject({ x: 155, y: 266, zoom: 2 });
    });
  });

  describe("restored Auto outcome (persisted, no re-measurement)", () => {
    it("reads a restored Building outcome from persistence without deciding again", async () => {
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "auto",
        officeAutoView: "building",
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      caughtUp();

      expect(decide).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Auto · Building");
      expect(
        screen.getByTestId("comm-graph-office-auto-chip").textContent,
      ).toBe("Auto · Building · measured earlier");
    });
  });

  describe("readiness classification (F3)", () => {
    it("does not plan a restored Building before replay is ready, and classifies its cold arrival as hot once replay confirms it awaiting", async () => {
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      const plan = vi.spyOn(OFFICE_VIEWS.building, "plan");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      // Neither replay nor measurement alone is enough: `ready` gates on
      // both, so the planner must not have run yet.
      expect(plan).not.toHaveBeenCalled();

      const event: CommGraphEvent = {
        id: 1,
        timestamp: 10,
        hostId: HOST_A,
        kind: "a2a_message",
        senderAgentId: ARCHIVED_CHAT_ID,
        receiverAgentId: CHAT_ID,
        responseId: "request-cold-review",
        inReplyTo: null,
        expectReply: true,
        messageText: "Review",
        noticeReason: null,
        originKind: null,
        originChatId: null,
        originRefId: null,
      };
      act(() => {
        openedByHost.get(HOST_A)?.onSnapshot([event], 1);
        openedByHost.get(HOST_B)?.onSnapshot([], null);
      });

      // WAIT for the sync that carries the replayed status, rather than
      // reading whatever the last one happened to be. The snapshot lands,
      // the tile re-renders, the probe re-reports and only then does the
      // scene sync - several commits, and under a loaded cross-file run the
      // read can otherwise land on the sync from before the event.
      await waitFor(() => {
        expect(
          sync.mock.calls.at(-1)?.[0].statusById.get(ARCHIVED_CHAT_ID),
        ).toBe("awaiting");
      });
      const last = sync.mock.calls.at(-1)?.[0];
      if (last === undefined) throw new Error("scene never synced");
      const fresh = partitionOfficePopulation({
        agents: last.agents,
        statusById: last.statusById,
        previous: null,
      });
      const actual = last.partition.members.get(ARCHIVED_CHAT_ID);
      expect(last.statusById.get(ARCHIVED_CHAT_ID)).toBe("awaiting");
      // The classification a FRESH partition of this same finished input
      // reaches, not the provisional one a half-replayed snapshot would
      // have frozen.
      expect(actual?.hotAtArrival).toBe(
        fresh.members.get(ARCHIVED_CHAT_ID)?.hotAtArrival,
      );
      expect(actual?.hotAtArrival).toBe(true);
    });
  });

  describe("picking a view", () => {
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

    it("re-measures through the real Auto row, not by clearing the outcome directly", async () => {
      // The existing "re-measures once officeAutoView is cleared" case pins
      // the tile's REACTION to that write; this one drives the actual
      // gesture that produces it - the picker's own Auto row - so a
      // regression in the wiring between the two is not invisible to both.
      await reachAutoFloor();
      const decideSpy = vi.spyOn(officeAutoModule, "decideOfficeView");

      openPicker();
      fireEvent.click(screen.getByTestId("comm-graph-office-view-auto"));

      // Remounted with no box of its own yet - nothing to decide from.
      expect(decideSpy).not.toHaveBeenCalled();

      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });

      await waitFor(() => expect(decideSpy).toHaveBeenCalledTimes(1));
      expect(storedView()?.officeAutoView).toBe("floor");
    });

    it("adopts every registered view with exactly one canvas, never a stale second one (F7)", async () => {
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      await reachAutoFloor();
      for (const id of OFFICE_VIEW_IDS) {
        const beforeId =
          storedView()?.officeView ?? storedView()?.officeAutoView;
        const beforeElement = screen.getByTestId("comm-graph-office-canvas");
        // A gesture in flight on the OLD canvas - a removed key would let its
        // pending write land on the NEW one instead of being torn down with it.
        fireEvent.wheel(beforeElement, { deltaX: 80, deltaY: 90 });

        openPicker();
        fireEvent.click(screen.getByTestId(`comm-graph-office-view-${id}`));

        if (id !== beforeId) {
          // A genuinely different view is a genuinely different canvas
          // instance - never the same DOM node with a new officeView prop.
          expect(screen.getByTestId("comm-graph-office-canvas")).not.toBe(
            beforeElement,
          );
          expect(storedView()).toMatchObject({ x: 0, y: 0, zoom: 1 });
        }

        // The old canvas's debounced wheel-pan, if it survived the remount,
        // would land here - the exact write this case exists to catch.
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 180));
        });
        expect(storedView()?.officeView).toBe(id);
        if (id !== beforeId) {
          expect(storedView()).toMatchObject({ x: 0, y: 0, zoom: 1 });
        }

        setOfficeCanvasSize({ width: 1040, height: 700 });
        setIntersecting(true);
        const scene = sync.mock.contexts.at(-1);
        if (!(scene instanceof OfficeScene)) throw new Error("no actual scene");
        expect(scene.layout()?.view).toBe(id);
        // ONE canvas on screen for this view - not the old one lingering
        // beside a new one that never replaced it.
        expect(
          screen.getAllByRole("img", {
            name: "Office view of the communication graph",
          }),
        ).toHaveLength(1);
      }
    });
  });

  /**
   * ONE VIEW ALIVE PER TILE, driven through the real picker on the real keyed
   * tile: [Performance rule 1](the plan's performance artifact), whose whole
   * mechanism is that a view change is an unmount and a mount rather than a
   * scene swapped underneath a canvas that stays put.
   *
   * WHAT jsdom CAN SEE of that, and what it cannot. There is no 2D context
   * here, so the canvas's frame loop never starts and its static layer is
   * never even constructed - "one static layer" and "a sprite cache within
   * its cap" are not observable from a tile in this environment, and are
   * pinned where they are observable instead (`office-static-layer.test.ts`
   * for the layer's own budget and release, `views/__tests__/
   * office-plan-perf.test.ts` for the sprite working set). What survives the
   * missing context is the scene: it is built and synced by an effect that
   * needs no context at all, so how many scenes a tile has, and which of them
   * are still live, is exactly answerable - and it is the half of the rule
   * that could actually regress, since the canvas holds its scene in a ref
   * keyed by EPIC id alone and it is the tile's `key` that retires it.
   */
  describe("switching views", () => {
    /** One round of the rule's own cycle. */
    const VIEW_CYCLE: ReadonlyArray<OfficeViewId> = [
      "building",
      "city",
      "floor",
    ];
    const SWITCH_ROUNDS = 10;

    /**
     * Picks a view and hands the canvas that replaces the old one what it
     * needs to be alive: a remount starts with no intersection state and no
     * measured box of its own.
     */
    /** The distinct scene instances a spy has seen sync. */
    function scenesSeen(spy: MockInstance<OfficeScene["sync"]>): number {
      return new Set(spy.mock.contexts).size;
    }

    it("reaches every registered view, and the picker says which one it is on", async () => {
      await reachAutoFloor();

      for (const viewId of OFFICE_VIEW_IDS) {
        await pickView(viewId);

        expect(storedView()?.officeView).toBe(viewId);
        // The trigger is the surface's own answer to "which office is this",
        // and a view registered tomorrow has to be reachable through it.
        expect(
          screen.getByTestId("comm-graph-office-view-picker").textContent,
        ).toContain(OFFICE_VIEWS[viewId].label);
        expect(screen.getAllByTestId("comm-graph-office-canvas")).toHaveLength(
          1,
        );
      }
    });

    it("builds one scene per real change and none for a pick that changes nothing", async () => {
      await reachAutoFloor();
      const syncSpy = vi.spyOn(OfficeScene.prototype, "sync");
      // The Floor is already on screen, resolved by Auto; pinning it writes
      // the choice without changing the view, so the canvas's key does not
      // move and the scene in hand is the one that stays.
      await pickView("floor");
      expect(scenesSeen(syncSpy)).toBe(1);

      await pickView("towers");

      // A different view is a different office: a new canvas, and with it a
      // new scene, rather than the Floor's scene handed a Towers layout.
      expect(scenesSeen(syncSpy)).toBe(2);
    });

    it("leaves exactly one scene alive after ten Floor, Building, City rounds", async () => {
      await reachAutoFloor();
      const built = vi.spyOn(OfficeScene.prototype, "sync");
      for (let round = 0; round < SWITCH_ROUNDS; round += 1) {
        for (const viewId of VIEW_CYCLE) {
          await pickView(viewId);
        }
      }

      // Every switch was real, so every switch built its own scene: a tile
      // that reused one canvas across the picks would show ONE here, which is
      // the regression this cycle exists to catch. The Floor's scene from
      // before the spy went in is not among them - the first pick retires it
      // without it ever syncing again, which is itself the rule working.
      expect(scenesSeen(built)).toBe(SWITCH_ROUNDS * VIEW_CYCLE.length);
      expect(screen.getAllByTestId("comm-graph-office-canvas")).toHaveLength(1);
      expect(storedView()?.officeView).toBe("floor");

      // And every one of them but the last is GONE, rather than merely
      // unreferenced by the canvas that replaced it: a scene left behind by a
      // leaked mount would still be listening, and would sync along with the
      // live one the moment the tile came back into view. Cleared rather than
      // re-spied: `vi.spyOn` hands back the spy already on the method, so a
      // second one would carry the first one's thirty contexts with it.
      built.mockClear();
      setIntersecting(false);
      setIntersecting(true);
      await act(async () => {
        await Promise.resolve();
      });

      expect(scenesSeen(built)).toBe(1);
    });
  });

  /**
   * THE DEV BENCH. A thousand agents is the scale every number in the plan is
   * quoted at and the one nobody has an epic for, so the acceptance pass opens
   * `?officeBench=<n>` instead - and what makes those numbers mean anything is
   * that the bench enters through the tile's ORDINARY input path, upstream of
   * the projection, the partition and the plan.
   */
  describe("the dev bench", () => {
    function benchAt(search: string): () => void {
      const original = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState({}, "", search);
      return () => {
        window.history.replaceState({}, "", original);
      };
    }

    it("draws an office for an epic with no agents in it at all", async () => {
      // The whole point of the bench: no epic, no host, no chats - and a floor
      // with a thousand desks on it if you ask for one.
      harness.teardown();
      harness.install(seedEmptyDoc, "owner");
      const restore = benchAt("?officeBench=12");
      try {
        await renderOfficeTile();
        await waitFor(() => {
          expect(screen.getByTestId("comm-graph-office-canvas")).toBeDefined();
        });
        setIntersecting(true);
        setOfficeCanvasSize({ width: 1040, height: 700 });
        await act(async () => {
          await Promise.resolve();
        });

        expect(screen.queryByTestId("comm-graph-empty")).toBeNull();
        // The accessible list is one entry per agent the floor is showing, so
        // it is the bench's population as the office actually received it.
        expect(screen.getAllByTestId(/^comm-graph-office-agent-/)).toHaveLength(
          12,
        );
      } finally {
        restore();
      }
    });

    it("dresses a benched office in the fixture's own statuses", async () => {
      // THE MOVING BENCH. Everything the canvas derives a status from is keyed
      // by agents that exist on a host, so a synthetic population reads as a
      // floor of idle agents - and a still office cannot answer a p95 frame
      // time or a long-task profile. Read off the SCENE's input, because that
      // is where the branch has to land: statuses reach nothing else.
      //
      // On the SEEDED epic, which is how a bench is actually opened: a real
      // epic with the parameter added to its address. An empty document never
      // opens a subscription, so its inputs never settle and its office never
      // syncs a scene to read.
      const restore = benchAt("?officeBench=12");
      const synced = vi.spyOn(OfficeScene.prototype, "sync");
      try {
        await reachAutoFloor();
        // Pinning the view Auto already chose is what puts a scene in hand
        // here: it writes the choice without moving the canvas's key, and the
        // scene syncs on the input that follows. The same step the switch
        // cases above take for the same reason.
        await pickView("floor");

        await waitFor(() => {
          expect(synced.mock.calls.length).toBeGreaterThan(0);
        });
        const fixture = makeTestEpic("triage", 12, OFFICE_BENCH_SEED);
        const input = synced.mock.calls[synced.mock.calls.length - 1][0];
        expect([...input.statusById]).toEqual([...fixture.statusById]);
        // Anti-vacuity: an empty map is what the epic's own derivation gives a
        // population it has never heard of, which is the bug this case is for.
        expect(input.statusById.size).toBeGreaterThan(0);
      } finally {
        synced.mockRestore();
        restore();
      }
    });

    it("leaves the epic's own agents alone when nothing asks for a bench", async () => {
      // The gate is the URL and nothing else: the fixture's four agents are
      // what this tile draws on every other case in this file. Waited for the
      // same way the rest of the suite waits - the epic's agents arrive from
      // the projection a tick after the render, and a tile with none of them
      // yet is the empty graph rather than an office.
      await renderOfficeTile();
      await waitFor(() => {
        expect(
          screen.getByTestId(`comm-graph-office-agent-${CHAT_ID}`),
        ).toBeDefined();
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getAllByTestId(/^comm-graph-office-agent-/)).toHaveLength(
        4,
      );
    });
  });
});
