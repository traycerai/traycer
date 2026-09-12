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
import type { CommGraphOfficeCanvasProps } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import * as officeAutoModule from "@/lib/comm-graph/office/office-auto";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";
import { OFFICE_BENCH_SEED } from "@/components/epic-canvas/comm-graph/office/office-bench";
import {
  OFFICE_VIEWS,
  OFFICE_VIEW_IDS,
  type OfficePlanInput,
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
import type {
  OfficeLayout,
  OfficeRect,
} from "@/lib/comm-graph/office/office-types";
import { useCommGraphAgents } from "@/components/epic-canvas/comm-graph/use-comm-graph-agents";
import { __resetCommGraphRegistryForTests } from "@/lib/comm-graph/comm-graph-registry";

/**
 * The Building's REAL planner, captured at import before any spy can replace
 * it - so a case that spies on `plan` to record what was drawn can still ask
 * what a plan of its own would have come to.
 */
const BUILDING_PLAN = OFFICE_VIEWS.building.plan;

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
        // A CONSTANT, and deliberately so: `set` discards every write, so
        // nothing here carries state and `save`/`restore` have nothing to
        // unwind. That is what keeps this double clear of the defect the
        // canvas suite's two doubles had (T2 fixup 8), where a persisted
        // `font` / `letterSpacing` made every measurement after the first
        // sign plate model a browser that does not exist.
        //
        // It is immune by CONSTRUCTION, not by design, and the distinction
        // matters to whoever reads this next: 6 px/char is the untracked
        // name-tag face and nothing else. It is font-blind, so it is
        // accidentally right for a tag and under-reports a sign plate by its
        // tracking and its padding. No case in this file reads a width
        // today. The first one that asserts a FIT must not use this - give
        // it a real modelled measure, or it will pass against a face that
        // was never drawn.
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
 * The `ready` prop most recently handed to a spied-on canvas component - the
 * fixup 8 fact under test, read the same way `lastCanvasCamera` reads `view`:
 * off what the canvas was actually GIVEN, not off a side effect of what it
 * did with it. Typed directly against `CommGraphOfficeCanvasProps` through
 * the spy's own `MockInstance` generic, rather than the untyped-call-args
 * shape `lastCanvasCamera` has to narrow at runtime.
 */
function lastCanvasReady(
  spy: MockInstance<typeof officeCanvasModule.CommGraphOfficeCanvas>,
): boolean | null {
  const props: CommGraphOfficeCanvasProps | undefined =
    spy.mock.calls.at(-1)?.[0];
  return props === undefined ? null : props.ready;
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
 * the real risk is a probe that never reaches a truthful `drawReady`
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
      //
      // D68: seeded through the OFFICE's own writer, exactly as the
      // neutralising case below is. Seeding the graph's `x`/`y`/`zoom` here
      // would pass without proving anything - Auto's write never touches
      // those fields now, so the "keeps it" arm it is meant to pin
      // (`decision.view === "floor" ? node.view.officeCamera : null`) would
      // go untested while the test still went green.
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      act(() => {
        useEpicCanvasStore.getState().updateCommGraphTileOfficeCameraInTab(
          AUTO_TAB_ID,
          commGraphTileId(EPIC_ID),
          {
            x: 111,
            y: 222,
            zoom: 2,
          },
          "floor",
        );
      });

      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      markHistoryCaughtUp();

      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });
      expect(storedView()?.officeCamera).toEqual({ x: 111, y: 222, zoom: 2 });
    });

    it("neutralises the camera when Auto's first outcome is not Floor", async () => {
      // The saved camera was framed for a Floor. Landing on a different view
      // through those same numbers would be a view of empty space, so the
      // patch that writes the outcome resets the camera in the same write.
      //
      // D68: the OFFICE's own camera path is what seeds this, now that it is
      // a field of its own rather than the shared x/y/zoom - the graph's
      // writer (`updateCommGraphTileCameraInTab`) cannot reach it any more.
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      act(() => {
        useEpicCanvasStore.getState().updateCommGraphTileOfficeCameraInTab(
          AUTO_TAB_ID,
          commGraphTileId(EPIC_ID),
          {
            x: 111,
            y: 222,
            zoom: 2,
          },
          "floor",
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
      expect(storedView()?.officeCamera).toBeNull();
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
      // D68: the camera under test is the OFFICE's, which since D68 lives in
      // `officeCamera` and not the top-level x/y/zoom (the graph's now) - the
      // claim is unchanged, only where it is read from.
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
        officeCamera: null,
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
      //
      // D68: the camera under test is the office's own, seeded through
      // `officeCamera` rather than the top-level fields, which are the
      // graph's now and would sit unread by anything in office mode.
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: "floor",
      });

      await waitFor(() =>
        expect(
          screen.getByTestId("comm-graph-office-view-picker").textContent,
        ).toBe("Towers"),
      );
      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeCameraView: "towers",
      });
    });

    it("leaves the camera untouched on mount when the record already matches the resolved view", async () => {
      // D68: seeded in `officeCamera`, which is the field the mount-time
      // reset would clear. Seeding the graph's `x`/`y`/`zoom` would make this
      // vacuous - nothing in this scenario writes them either way, so the
      // case would stay green even if the reset fired on every mount.
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: "floor",
      });

      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
        // D68: the camera the office runtime actually reads is
        // `officeCamera`, not the top-level fields (the graph's now) -
        // seeded there so this is a real test of the runtime this ticket is
        // about, not of a field nothing reads in office mode.
        await renderSeededOfficeInLoadedSession({
          ...DEFAULT_COMM_GRAPH_VIEW,
          officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
          officeCamera: null,
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
      // D68: seeded through `officeCamera`, same reasoning as the case above.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: "floor",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
      // D68: seeded through `officeCamera` - the camera under test is the
      // office's, and the top-level fields are the graph's now.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
        officeCamera: null,
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
      // D68: the persisted-relative-to-neutral claim reads `officeCamera`
      // now, not the top-level fields.
      expect(storedView()?.officeCamera?.x).not.toBe(-10020);
      expect(storedView()?.officeCamera?.y).not.toBe(-20030);
    });

    it("does not fire when the default never moves, even with no framing record", async () => {
      // The control against the case above: a witness with nothing to
      // report must not manufacture a reset on its own. `officeCameraView`
      // staying null (not stamped to the resolved view) is the tell - a
      // store-side stamp instead of a render-phase witness would have
      // written a fabricated record here even though nothing moved.
      // D68: seeded through `officeCamera`, same reasoning as the case above.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
      //
      // D68: seeded through `officeCamera`, same reasoning as every other
      // case in this describe block.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
      // D68: seeded through `officeCamera` (same reasoning as the rest of
      // this describe block), and the store-side comparison at the end
      // reads `officeCamera` too - the canvas's `view` prop is still the
      // PROJECTION (`officeCamera ?? NEUTRAL_CAMERA`) built for it, so
      // `handedCamera` is unaffected, but the raw stored view's x/y/zoom are
      // the graph's now and would never move regardless of what the office
      // panned to.
      const { step } = installCanvas();
      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
      const storedOfficeCamera = storedView()?.officeCamera ?? null;
      if (storedOfficeCamera === null) {
        throw new Error("no stored office camera");
      }
      // The comparison below only means something if the store actually
      // moved off neutral - otherwise a wheel that silently became a no-op
      // would still pass, since a neutral `handedCamera` and a neutral
      // `stored` agree trivially. This is what stops that from happening
      // unnoticed; it doesn't pin exact coordinates, same reasoning as case 1.
      expect(storedOfficeCamera).not.toMatchObject({ x: 0, y: 0, zoom: 1 });
      expect(handedCamera).toMatchObject({
        x: storedOfficeCamera.x,
        y: storedOfficeCamera.y,
        zoom: storedOfficeCamera.zoom,
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
        // D68: seeded through `officeCamera` - the top-level fields are the
        // graph's now and would never move regardless of the office's story.
        const { step } = installCanvas();
        const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
        const frames = vi.spyOn(OfficeScene.prototype, "frame");
        const sync = vi.spyOn(OfficeScene.prototype, "sync");
        useSettingsStore.getState().setAgentOfficeDefaultView("auto");
        await renderSeededOfficeInLoadedSession({
          ...DEFAULT_COMM_GRAPH_VIEW,
          officeCamera: { x: -10000, y: -20000, zoom: 4 },
          officeCameraView: null,
        });
        setOfficeCanvasSize({ width: 1040, height: 700 });
        setIntersecting(true);
        // Replay still pending - Auto has nothing to decide from, which is
        // what keeps the resolved view at `null` here.
        expect(decide).not.toHaveBeenCalled();
        expect(storedView()).toMatchObject({
          officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
          officeCamera: null,
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
        expect(storedView()?.officeCamera?.x).not.toBe(-10020);
        expect(storedView()?.officeCamera?.y).not.toBe(-20030);
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
      // D68: seeded through `officeCamera`, same reasoning as the case above.
      const { step } = installCanvas();
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: "towers",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      expect(decide).not.toHaveBeenCalled();
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
        officeCamera: null,
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
      expect(storedView()?.officeCamera?.x).not.toBe(-10020);
      expect(storedView()?.officeCamera?.y).not.toBe(-20030);
    });

    it("leaves an explicit pick's own reset alone - the pick's write did it, not the witness", async () => {
      // D68: seeded through `officeCamera`, same reasoning as the rest of
      // this describe block.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });

      chooseView("towers");

      // The pick's own write already reset the camera the store holds -
      // this is a fact about `handleOfficeViewChange`, nothing the witness
      // is even eligible to touch (an explicit pick never arms it).
      expect(storedView()).toMatchObject({
        officeView: "towers",
        officeCameraView: "towers",
        officeCamera: null,
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
      // D68: seeded through `officeCamera`, same reasoning as the rest of
      // this describe block.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
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
      // D68: seeded through `officeCamera`, same reasoning as the rest of
      // this describe block.
      const { step } = installCanvas();
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "floor",
        officeCameraView: "floor",
        officeCamera: { x: 155, y: 266, zoom: 2 },
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();
      expect(storedView()).toMatchObject({
        officeView: "floor",
        officeCameraView: "floor",
        officeCamera: { x: 155, y: 266, zoom: 2 },
      });

      chooseView("auto");

      // The re-pick neutralised the resolved view AND the camera in the
      // same write; the resolved view landing on `null` here is not
      // something the witness gets to act on.
      expect(storedView()).toMatchObject({
        officeView: "auto",
        officeAutoView: null,
        officeCameraView: null,
        officeCamera: null,
      });
    });
  });

  describe("graph camera untouched by an office default change (fixup 2, R3)", () => {
    it("leaves the active graph camera alone, and Office resumes framing neutral once it is active again", async () => {
      // D68 restructures exactly what this case is about, so the claim is
      // re-read rather than merely re-pointed at new fields.
      //
      // Before D68: the graph's pan survived a default change made while
      // Graph was active (R3's own claim), and switching back to Office then
      // RESET the shared viewport - which is what kept the office from
      // inheriting the graph's numbers as if they were an office camera.
      //
      // After D68: a mode switch resets nothing at all, in either direction
      // (that reset is precisely what N10 cost the office camera). The
      // graph's pan surviving the default change is UNCHANGED - it is still
      // the graph's alone, and a Settings change under Graph still can't
      // touch it. What differs is the second half: Office does not "resume
      // framing neutral" because a switch reset it - it never had anything
      // else to frame. `officeCamera` is a field of its own that this
      // sequence never touches, so the projection (`officeCamera ??
      // NEUTRAL_CAMERA`) still hands the office a neutral camera regardless
      // of where the graph's x/y/zoom sit. Read off what the office canvas
      // is actually HANDED - the raw stored view no longer speaks for the
      // office at all once Graph has moved its own fields.
      const officeSpy = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
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
        officeCamera: null,
        officeCameraView: null,
      });

      // Switching back to Office is NOT a camera event any more - the
      // graph's pan survives the switch untouched, in either field.
      fireEvent.click(screen.getByTestId("comm-graph-mode-office"));

      expect(storedView()).toMatchObject({
        mode: "office",
        x: 155,
        y: 266,
        zoom: 2,
        officeCamera: null,
        officeCameraView: null,
      });
      // The office still resumes framing NEUTRAL - not because anything
      // reset just now, but because `officeCamera` was never anything else,
      // and the projection reads that field alone, never the graph's.
      const camera = lastCanvasCamera(officeSpy);
      if (camera === null) {
        throw new Error("no camera prop was passed to the Office canvas");
      }
      expect(camera).toMatchObject({ x: 0, y: 0, zoom: 1 });
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

  describe("each renderer owns its camera, so a Graph detour cannot lose the office's framing (fixup 11, D68, N10)", () => {
    it("mounts the office back on its saved camera after a Graph detour that moved the graph's own camera", async () => {
      // THE HEADLINE. The live re-run's N10: zoom into the office, switch to
      // Graph, switch back, and before D68 the office returned at its
      // auto-fit rather than where it was left - because the one shared
      // camera was reset on every mode switch. Reproduced here end to end:
      // an office camera change, a detour through Graph that moves the
      // GRAPH's own camera, and back - the office must mount on the camera
      // it had, untouched by anything the graph did while it was away.
      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      await reachAutoFloor();

      // The office camera change.
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileOfficeCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            { x: 55, y: 66, zoom: 3 },
            "floor",
          );
      });
      expect(storedView()?.officeCamera).toEqual({ x: 55, y: 66, zoom: 3 });

      // The detour.
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
        await Promise.resolve();
      });
      expect(storedView()?.mode).toBe("graph");

      // A graph move-end camera write DURING the detour - exactly what a
      // debounced pan on the Graph canvas does.
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            { x: 900, y: -400, zoom: 1.5 },
          );
      });

      // Back to Office. Before D68 this reset the shared camera to neutral;
      // now nothing resets on a mode switch in either direction, so the
      // office's saved camera is exactly where the first write left it -
      // the graph's pan during the detour never had anywhere to reach it.
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      expect(storedView()).toMatchObject({
        mode: "office",
        officeCamera: { x: 55, y: 66, zoom: 3 },
        // The graph's own camera also survived the round trip, untouched by
        // the office's return - each renderer really does own its own.
        x: 900,
        y: -400,
        zoom: 1.5,
      });
      // THE ACTUAL CLAIM: the office canvas mounts framing the SAVED camera,
      // not the auto-fit N10 saw and not the graph's numbers either.
      const camera = lastCanvasCamera(office);
      if (camera === null) {
        throw new Error("no camera prop was passed to the Office canvas");
      }
      expect(camera).toMatchObject({ x: 55, y: 66, zoom: 3 });
    });

    it("a mode switch leaves the graph's camera exactly where it was, in either direction", async () => {
      // Red before D68: `handleModeChange` reset the shared viewport to
      // neutral on every switch, so the graph's own pan never survived one
      // either. Now the mode is the only thing a switch touches.
      const graphCanvas = vi.spyOn(commGraphCanvasModule, "CommGraphCanvas");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        x: 300,
        y: -150,
        zoom: 1.75,
      });
      expect(storedView()).toMatchObject({
        mode: "graph",
        x: 300,
        y: -150,
        zoom: 1.75,
      });

      fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
      expect(storedView()).toMatchObject({
        mode: "office",
        x: 300,
        y: -150,
        zoom: 1.75,
      });

      fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
      expect(storedView()).toMatchObject({
        mode: "graph",
        x: 300,
        y: -150,
        zoom: 1.75,
      });
      const camera = lastCanvasCamera(graphCanvas);
      if (camera === null) {
        throw new Error("no camera prop was passed to the Graph canvas");
      }
      expect(camera).toMatchObject({ x: 300, y: -150, zoom: 1.75 });
    });
  });

  describe("a mode switch releases the camera witness it was never meant to satisfy (fixup 12)", () => {
    // FINDING A. `nextArmedOn` releases the witness once TWO things are both
    // true: some writer has replaced the stored view object, AND the record
    // already names the arriving view. A mode switch satisfies the first
    // half for free (`handleModeChange` writes `{ ...node.view, mode }`, a
    // NEW object) and, whenever the record already happened to name the
    // view the default just moved TO, the second half is satisfied too -
    // with no office writer having framed anything. The module's own
    // comment says this must not happen: the witness has to survive any
    // write that is not itself the office's camera settling.
    //
    // Every case below seeds the same tile: GRAPH mode (the mode switch
    // that matters is the one still ahead), `officeView: null` and
    // `officeAutoView: null` (a followed default, nothing pinned), a
    // camera that has never addressed "towers" at all
    // (`{ x: -10000, y: -20000, zoom: 4 }`), and - the detail that makes
    // this the Graph-mode variant of the finding - `officeCameraView:
    // "towers"` ALREADY on the record, for reasons that have nothing to do
    // with the move about to happen (the tile could have been saved under
    // a Settings default of Towers long before Auto was ever picked).
    function seededTile(): CommGraphTileViewState {
      return {
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        officeView: null,
        officeAutoView: null,
        officeCameraView: "towers",
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
      };
    }

    it("keeps the witness armed through a mode switch when the record already names the arriving view", async () => {
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOffice(seededTile());
      expect(storedView()?.mode).toBe("graph");

      // THE ARMING MOVE: the default moves auto -> towers while Graph is
      // still up. Both reset effects return early outside office mode, so
      // this writes NOTHING to the store - the only trace it leaves is the
      // witness, which arms on the stored view object as it stands right
      // now (`officeCameraView: "towers"` already, camera still the stale
      // one seeded above).
      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );

      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      // THE RELEASING WRITE: a plain mode switch. `handleModeChange` writes
      // a new view object carrying the SAME `officeCameraView: "towers"` it
      // already had - which is exactly the pre-existing match the release
      // predicate mistakes for a writer that has just spoken FOR "towers".
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      // ASSERTION 1: the office runtime has to be BUILT neutral. A released
      // witness hands the canvas the stale `{-10000, -20000, 4}` on its
      // very first render - the camera never had anything to do with
      // Towers, and `createOfficeRuntime` only ever reads this once.
      expect(lastCanvasCamera(office)).toMatchObject({ x: 0, y: 0, zoom: 1 });

      await act(async () => {
        await Promise.resolve();
      });

      // ASSERTION 2: THE STORE IS SETTLED TOO. Reset effect 1 declines to
      // fire because the record already names "towers" - so today the
      // projection would be neutral (once assertion 1 holds) while the
      // STORE keeps the stale camera, and a reload before the office
      // happens to pan hands it straight back with the record still
      // vouching for it.
      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeCameraView: "towers",
      });
    });

    it("keeps the witness armed through an ordinary Graph write - a write on its own can be about something else", async () => {
      // THE VARIANT the design comment names explicitly: "a write on its
      // own can be about something else (a Graph pan while the move waits
      // for the office to come back)". A camera pan through the Graph's
      // own writer touches only `x`/`y`/`zoom` - fields the office does not
      // read - and must not be read as a writer having spoken FOR the
      // arriving office view, any more than the mode switch above should
      // have been.
      useSettingsStore.getState().setAgentOfficeDefaultView("auto");
      await renderSeededOffice(seededTile());
      expect(storedView()?.mode).toBe("graph");

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("towers"),
      );

      // THE GRAPH PAN, between the arming move and the mode switch.
      act(() => {
        useEpicCanvasStore
          .getState()
          .updateCommGraphTileCameraInTab(
            AUTO_TAB_ID,
            commGraphTileId(EPIC_ID),
            { x: 900, y: -400, zoom: 1.5 },
          );
      });
      expect(storedView()).toMatchObject({
        mode: "graph",
        x: 900,
        y: -400,
        zoom: 1.5,
      });

      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      // Same two assertions as the headline case...
      expect(lastCanvasCamera(office)).toMatchObject({ x: 0, y: 0, zoom: 1 });

      await act(async () => {
        await Promise.resolve();
      });

      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeCameraView: "towers",
        // ...plus the Graph's own camera has to have survived the whole
        // detour untouched - it is a different field entirely since D68,
        // and the office's own settling write touches only `officeCamera`
        // / `officeCameraView`.
        x: 900,
        y: -400,
        zoom: 1.5,
      });
    });

    it("a mode switch with no default move keeps the office camera exactly (N10 guard - what D68 exists for)", async () => {
      // THE GUARD. No Settings default move happens anywhere in this case:
      // the resolved view is already "towers" when the tile mounts and
      // stays "towers" throughout, so the witness never arms in the first
      // place - there is nothing here for the fix above to release
      // wrongly, or to hold rightly. This is exactly the case D68 added a
      // per-renderer camera to protect (a mode switch is not a camera
      // event), and the fix for the finding above must leave it alone:
      // expected GREEN both before this fixup and after it.
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOffice(seededTile());
      expect(storedView()?.mode).toBe("graph");

      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      expect(lastCanvasCamera(office)).toMatchObject({
        x: -10000,
        y: -20000,
        zoom: 4,
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: "towers",
      });
    });
  });

  describe("the reverse default move hands Auto's keep arm a camera the witness distrusts (fixup 12, Finding D)", () => {
    // THE MIRROR of the headline above. There the default moved between two
    // CONCRETE views while Graph was up, and the record already named the
    // arriving one - the store's own effects had nothing to say and only the
    // witness caught it. Here the default moves CONCRETE -> "auto" while
    // Graph is up, so `resolvedViewId` goes "towers" -> `null` (Auto has not
    // answered yet). That `null` is the one shape BOTH store-side effects
    // decline at (the followed-default effect returns on Graph mode at
    // `:518`; the record/witness effect returns on `resolvedViewId === null`
    // at `:575`), so the stale Towers camera survives in the store with
    // nothing but the witness left to remember that anything moved.
    //
    // Then Office mounts and REAL Auto answers Floor. The D52 keep arm at
    // `:631-640` (`decision.view === "floor" ? node.view.officeCamera :
    // null`) was written for a TRUSTED camera - a tile that predates the
    // choice, carrying a Floor-framed camera nothing has touched since. A
    // held witness is exactly the statement that this camera is not that:
    // a writer promised to speak for the arriving view and never has. The
    // keep arm preserves it anyway, unconditionally, and stamps `floor` -
    // vouching for Towers coordinates it was never told to distrust.
    //
    // THE RULING mid-fixup: declining only at the keep arm is not enough by
    // itself. It protects the runtime THIS mount builds, but a tile closed
    // and reopened in the window between the default move and Auto's
    // answer has no mount alive to decline anything - it gets the stale
    // camera handed straight back on parse, with the record still naming
    // "towers" (or, in the unstamped case below, naming nothing at all).
    // That is exactly requirement 3's gap. So the store has to retire the
    // camera WHILE THE VIEW IS STILL UNRESOLVED, on the witness alone -
    // before Auto, before a reload, before anything else gets a say.
    function seededTowersToAutoTile(
      officeCameraView: OfficeViewId | null,
    ): CommGraphTileViewState {
      return {
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        officeView: null,
        officeAutoView: null,
        officeCameraView,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
      };
    }

    it("retires the stale camera while still unresolved, and builds the first resolved Floor runtime neutral (Settings towers -> auto, stamped record)", async () => {
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      // Seeded at Finding B's own non-neutral numbers, not the default -
      // zeroing an already-zero Graph camera would pass whether or not the
      // newly-enabled unresolved-reset path also (wrongly) neutralised the
      // GRAPH's fields, which is exactly the blind spot that hid Finding B.
      // Asserted immediately below, before the Settings move, so a mis-seed
      // fails loudly here instead of laundering into a false pass later.
      await renderSeededOffice({
        ...seededTowersToAutoTile("towers"),
        x: 155,
        y: 266,
        zoom: 2,
      });
      expect(storedView()?.mode).toBe("graph");
      expect(storedView()).toMatchObject({ x: 155, y: 266, zoom: 2 });

      // THE ARMING MOVE, reversed from the headline: Settings towers ->
      // auto while Graph is still up. `resolvedViewId` goes "towers" ->
      // `null` - Auto has not measured anything yet - which is the one
      // shape neither store-side effect will touch.
      act(() => useSettingsStore.getState().setAgentOfficeDefaultView("auto"));

      // ASSERTION 1, and the reviewer's mid-fixup ruling: the store must
      // retire the camera HERE, before Auto ever runs and while Graph is
      // still the mode on screen - a reload in this exact window has only
      // the record to go on, and the record still names "towers" over a
      // camera nothing has framed for the arriving (unresolved) view.
      // RED today: both effects decline on `resolvedViewId === null` /
      // the Graph-mode gate, so nothing retires it - the camera and its
      // stale stamp both survive untouched.
      expect(storedView()).toMatchObject({
        mode: "graph",
        officeCamera: null,
        officeCameraView: null,
      });

      // Switch to Office. `resolvedViewId` is still `null` - Auto has
      // nothing to decide from yet - so this mounts on the measuring view
      // first, exactly as every other "Auto has not answered" case in
      // this file does.
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      // REAL Auto, not a stub: this fixture's handful of agents fits the
      // Floor comfortably at 1040x700, the same fixture every other Auto
      // case in this file relies on.
      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });

      // The Auto answer remounts the canvas (measuring -> floor), and that
      // remount only reports its own eligibility on the frame this next
      // `step()` drives - same two-step pattern as "keeps a resolved Floor
      // camera when Auto answers" above.
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      step();

      // ASSERTION 2: the FIRST resolved Floor runtime is read off the
      // ACTUAL scene it painted, not off `lastCanvasCamera`'s last-render
      // props (which answers a different, weaker question and never
      // installs a canvas or steps a frame at all). With `officeCamera`
      // retired to `null`, `isDefaultCommGraphView` is true and auto-fit
      // arms, so the Floor frame lands on the fitted rect below; the keep
      // arm's unconditional preservation of the stale Towers camera would
      // instead have produced the far-off-screen frame the sibling "keeps a
      // resolved Floor camera" case pins at `{ x: 2500, y: 5000, width:
      // 260, height: 175 }` - not close to this one.
      const state = lastFrameAndBounds(frames, sync);
      expect(state.frame).toEqual({
        x: -498.4049079754601,
        y: -35.92638036809816,
        width: 1556.8098159509202,
        height: 1047.8527607361964,
      });

      // ASSERTION 3: the Graph's own camera was never anyone's business in
      // this sequence and has to read exactly as seeded throughout - not
      // merely "still the default", which a wrongly-broadened reset could
      // satisfy by coincidence, but the actual non-neutral numbers seeded
      // above. This whole detour is about the OFFICE's `officeCamera`, a
      // different field since D68.
      expect(storedView()).toMatchObject({ x: 155, y: 266, zoom: 2 });
    });

    it("retires the stale camera while still unresolved even with no stamp at all - the legacy variant with the same store-settlement gap", async () => {
      // Identical to the case above except `officeCameraView: null` - a
      // camera persisted before the stamp field ever existed. This is the
      // case that separates the two kinds of evidence `officeViewForCanvas`
      // reads as an OR: the RECORD (a name the camera was saved under) and
      // the WITNESS (a mount that watched the default move). A fix that
      // only consults the record - "does `officeCameraView` disagree with
      // where we are headed" - has nothing to read here: the record has
      // always said "nobody framed this" and will keep saying so no matter
      // what the default does. Only the witness knows a default move
      // happened at all, so if store settlement is wired through the
      // record alone, this case still fails while the stamped case above
      // passes.
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      // Same Finding-B seed as the stamped case above, for the same reason:
      // the default camera can't tell a wrongly-broad neutralisation of the
      // GRAPH's fields from a correct no-op, and asserted immediately so a
      // mis-seed is caught here rather than mistaken for a pass later.
      await renderSeededOffice({
        ...seededTowersToAutoTile(null),
        x: 155,
        y: 266,
        zoom: 2,
      });
      expect(storedView()?.mode).toBe("graph");
      expect(storedView()).toMatchObject({ x: 155, y: 266, zoom: 2 });

      act(() => useSettingsStore.getState().setAgentOfficeDefaultView("auto"));

      // ASSERTION 1, same ruling as the stamped case: the store must
      // retire the camera while still unresolved and Graph is up. RED
      // today, and for the same reason - `resolvedViewId === null` blocks
      // both effects regardless of what the record does or does not say.
      expect(storedView()).toMatchObject({
        mode: "graph",
        officeCamera: null,
        officeCameraView: null,
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      caughtUp();
      step();

      await waitFor(() => {
        expect(storedView()?.officeAutoView).toBe("floor");
      });

      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      step();

      // ASSERTION 2: same as the stamped case - read off the actual scene
      // the first resolved Floor runtime painted, not `lastCanvasCamera`'s
      // last-render props. Neutral retirement here means auto-fit arms and
      // this lands on the same fitted frame as the stamped case; a
      // record-only fix has no evidence to distrust in this legacy variant
      // (no stamp at all) and would leave the stale Towers camera in place,
      // producing the far-off-screen frame instead.
      const state = lastFrameAndBounds(frames, sync);
      expect(state.frame).toEqual({
        x: -498.4049079754601,
        y: -35.92638036809816,
        width: 1556.8098159509202,
        height: 1047.8527607361964,
      });

      // ASSERTION 3: the Graph's camera, untouched throughout - the actual
      // seeded numbers, not merely "still the default".
      expect(storedView()).toMatchObject({ x: 155, y: 266, zoom: 2 });
    });

    it("an explicit pick of the already-resolved view finds nothing left to preserve (pick sibling, ~687) - green by timing, not by rule", async () => {
      // The pick sibling has its own preservation arm: `next ===
      // resolvedViewId ? node.view.officeCamera : null`. To exercise it
      // with a witnessed move actually held, `resolvedViewId` has to stay
      // CONCRETE the whole time - unlike the two cases above, which route
      // through Auto's `null`. So this arms the witness on towers ->
      // campus instead, both concrete.
      //
      // The reason this is expected to come back GREEN rather than red:
      // whenever `resolvedViewId` is concrete, the record/witness reset
      // effect (`:566`) is not blocked by the `resolvedViewId === null`
      // guard at all, and - since D68/fixup 12 - it carries NO mode gate
      // either. So it retires the stale camera and releases the witness
      // the moment the default move resolves to something concrete,
      // whether Graph or Office is on screen, well before any pick could
      // ever see an armed witness sitting over a non-null camera. The pick
      // arm is unreachable by TIMING here - the other effect always wins
      // the race - not because the arm itself knows to decline a
      // witnessed camera the way Finding D's fix teaches the keep arm to.
      useSettingsStore.getState().setAgentOfficeDefaultView("towers");
      await renderSeededOffice(seededTowersToAutoTile("towers"));
      expect(storedView()?.mode).toBe("graph");

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("campus"),
      );

      // Confirms the timing claim above before doing anything else: the
      // camera is already retired, WHILE GRAPH IS STILL UP, with no mode
      // switch and no pick in sight yet.
      expect(storedView()).toMatchObject({
        mode: "graph",
        officeCamera: null,
        officeCameraView: "campus",
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      // An explicit pick of "campus" - the view already resolved and
      // already showing - exercises the pick sibling's own keep arm at
      // `:687`.
      chooseView("campus");

      // GREEN: there was never a non-null camera left for this arm to
      // preserve by the time it could run.
      expect(storedView()).toMatchObject({
        officeView: "campus",
        officeCameraView: "campus",
        officeCamera: null,
      });
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

  describe("readiness classification (F3, revised by fixup 8/H1)", () => {
    it("plans a restored Building before replay is ready (fixup 8 draws it), and still classifies its cold arrival as hot once replay confirms it awaiting", async () => {
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      const plan = vi.spyOn(OFFICE_VIEWS.building, "plan");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      // F3 asserted the planner had NOT run here; fixup 8/H1 is exactly the
      // reversal of that gate for an explicit view - the caught-up feed is
      // no longer an input to the first plan, only to what gets classified
      // and committed as the settled partition (proven below via
      // `hotAtArrival`). Measurement and eligibility alone are enough.
      expect(plan).toHaveBeenCalled();

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

  describe("the plan the settled feed owes (fixup 8c, P2)", () => {
    /**
     * FIXUP 8 DREW THE OFFICE EARLY AND THEN LEFT IT THERE.
     *
     * The floor an explicit view draws while the feed is behind is planned
     * from statuses that are still arriving, so nobody is busy and the woken
     * agent's desk does not exist yet. The case above proves the PARTITION
     * settles - that is F3's half, and it passed all along - while this one
     * proves the drawn floor does too, which it did not: the agent set does
     * not change when a status finally arrives, and a status flip alone
     * deliberately never re-plans, so the rendered plan stayed the draft for
     * the life of the mount. That is the cold reviewer's P2, reproduced here
     * through the real tile.
     *
     * Read off the PLANNER's own calls rather than the store or the frame:
     * the claim is about the plan the canvas is drawing, and the last plan the
     * view was asked for is exactly that.
     */
    it("re-plans the rendered floor from the settled partition, so the woken agent's seat is the desk a settled plan gives it", async () => {
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      const planned: Array<{
        readonly input: OfficePlanInput;
        readonly layout: OfficeLayout;
      }> = [];
      const plan = vi
        .spyOn(OFFICE_VIEWS.building, "plan")
        .mockImplementation((input) => {
          const layout = BUILDING_PLAN(input);
          planned.push({ input, layout });
          return layout;
        });
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
      });
      setOfficeCanvasSize({ width: 1040, height: 700 });
      setIntersecting(true);
      // The draft: drawn, and drawn from a feed that has told nobody
      // anything yet.
      expect(plan).toHaveBeenCalled();
      const draft = planned.at(-1);
      if (draft === undefined) throw new Error("nothing was planned");
      expect(draft.input.previous).toBeNull();

      const event: CommGraphEvent = {
        id: 1,
        timestamp: 10,
        hostId: HOST_A,
        kind: "a2a_message",
        senderAgentId: ARCHIVED_CHAT_ID,
        receiverAgentId: CHAT_ID,
        responseId: "request-settle-probe",
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

      // The same wait the case above takes, and for the same reason: the
      // snapshot lands, the tile re-renders, the probe re-reports, and only
      // then does the scene sync.
      await waitFor(() => {
        expect(
          sync.mock.calls.at(-1)?.[0].statusById.get(ARCHIVED_CHAT_ID),
        ).toBe("awaiting");
      });
      const last = sync.mock.calls.at(-1)?.[0];
      if (last === undefined) throw new Error("scene never synced");
      // NO SECOND WAIT for a plan. The settle is reported by the very sync
      // whose argument the wait above just read, and a sync plans inside
      // itself - so the last plan is already the settled one if there is
      // going to be one at all. Waiting for a second plan would turn the
      // defect into a five-second timeout instead of the one-line
      // disagreement it is.
      const rendered = planned.at(-1);
      if (rendered === undefined) throw new Error("nothing was planned");

      // The floor a scene that had waited for the feed would have drawn.
      const settledPlan = BUILDING_PLAN({
        agents: last.agents,
        partition: last.partition,
        occupancy: new Map<string, string>(),
        needsCapacity: [],
        activityById: last.activityById,
        viewport: last.viewport,
        previous: null,
      });
      expect(rendered.layout.desks.get(ARCHIVED_CHAT_ID)?.kind).toBe(
        settledPlan.desks.get(ARCHIVED_CHAT_ID)?.kind,
      );
      expect(rendered.layout.desks.get(ARCHIVED_CHAT_ID)?.kind).toBe("desk");
      // And it was planned from the settled population, not merely re-planned
      // from the provisional one: the classification the rendered floor was
      // built on is the classification the sync is carrying.
      expect(
        rendered.input.partition.members.get(ARCHIVED_CHAT_ID)?.hotAtArrival,
      ).toBe(last.partition.members.get(ARCHIVED_CHAT_ID)?.hotAtArrival);
      expect(
        rendered.input.partition.members.get(ARCHIVED_CHAT_ID)?.hotAtArrival,
      ).toBe(true);
    });
  });

  describe("an explicit view draws while the feed is behind (fixup 8, H1)", () => {
    it("hands the canvas ready:true and lets the real Towers planner run before the feed catches up", async () => {
      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      const plan = vi.spyOn(OFFICE_VIEWS.towers, "plan");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "towers",
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      // Deliberately no `caughtUp()` here - this IS the H1 reproduction: the
      // local server lost its database mid-sitting and the feed never
      // caught up, and an explicit Towers tile drew nothing for 25 minutes
      // while the Graph beside it drew every node from the same snapshot.
      // This is a standalone assertion on purpose, reachable only through
      // the prop the canvas was actually HANDED - a suite that only checked
      // the planner ran (below) could still be fooled by a `ready` wired to
      // something other than what fixup 8 changed.
      expect(lastCanvasReady(office)).toBe(true);
      // And the canvas acted on it for real: the actual Towers planner ran
      // against the loaded snapshot, not merely a prop nobody consumed.
      expect(plan).toHaveBeenCalled();
    });

    it("still waits for Auto: ready stays false and no decision runs until the feed catches up, and the chip keeps reading measuring", async () => {
      // The tile's OWN gate for a drawable office loosened in fixup 8, but
      // Auto's gate is a different one and the plan explicitly keeps it: a
      // partition measured off a half-replayed feed could pick the wrong
      // view and PERSIST that choice, so nothing here is meant to change
      // for Auto. This is the `ready` half of that guarantee - the existing
      // "does not run while the snapshot is a partial one" case only ever
      // read the store's `officeAutoView` and the decide spy, never what
      // the canvas itself was handed.
      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      const decide = vi.spyOn(officeAutoModule, "decideOfficeView");
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(lastCanvasReady(office)).toBe(false);
      expect(decide).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("comm-graph-office-auto-chip").textContent,
      ).toBe("Auto · measuring…");

      caughtUp();
      await waitFor(() => {
        expect(storedView()?.officeAutoView).not.toBeNull();
      });
      // The decision remounts the canvas onto its now-resolved view - a NEW
      // container element with no measurement of its own yet, same as any
      // other view change in this file (see `pickView`) - so it needs the
      // same eligibility and size signals given again before it can report
      // a probe and become ready.
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      await waitFor(() => {
        expect(lastCanvasReady(office)).toBe(true);
      });
    });

    it("shows the catching-up chip while the explicit Towers tile draws behind the feed, and clears it once caught up", async () => {
      // The population between "who is here" and "who is busy" is real, and
      // this is where a person is told about it: not a spinner over an
      // office that is already drawn, just a line that goes away once the
      // feed says the statuses on screen are settled.
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "towers",
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      expect(
        screen.getByTestId("comm-graph-office-catching-up-chip").textContent,
      ).toContain("Catching up");

      caughtUp();
      expect(
        screen.queryByTestId("comm-graph-office-catching-up-chip"),
      ).toBeNull();
    });

    it("does not show the catching-up chip while Auto is only measuring - one chip for one wait", async () => {
      // Auto's own wait already has its own chip (`Auto · measuring…`,
      // pinned above); the catching-up chip is about a DRAWN office whose
      // statuses may lag, which is not what an undecided Auto tile is
      // showing at all. Two chips claiming the same wait would be
      // confusing even if neither were wrong on its own.
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize({ width: 1040, height: 700 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.queryByTestId("comm-graph-office-catching-up-chip"),
      ).toBeNull();
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
      // D68: the camera under test is the office's own - seeded through
      // `updateCommGraphTileOfficeCameraInTab`, the writer that reaches
      // `officeCamera`, since the graph's writer can no longer touch it.
      await reachAutoFloor();
      act(() => {
        useEpicCanvasStore.getState().updateCommGraphTileOfficeCameraInTab(
          AUTO_TAB_ID,
          commGraphTileId(EPIC_ID),
          {
            x: 55,
            y: 66,
            zoom: 3,
          },
          "floor",
        );
      });

      openPicker();
      fireEvent.click(screen.getByTestId("comm-graph-office-view-towers"));

      expect(storedView()?.officeView).toBe("towers");
      expect(storedView()?.officeCamera).toBeNull();
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
