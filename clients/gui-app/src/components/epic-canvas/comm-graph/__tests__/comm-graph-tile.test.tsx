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
// stub: `use-comm-graph-snapshot.ts` builds its cloud opener as
// `cloudOpenerOverride ?? createCommGraphCloudSubscriptionOpener(openTransport)`,
// and `??` short-circuits - with `__setCommGraphCloudSubscriptionOpenerForTests`
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
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentStatus,
  OfficeSize,
  OfficeViewId,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_BENCH_SCRIPT_STEP_MS,
  OFFICE_BENCH_SEED,
  officeBench,
  parseOfficeBenchSearch,
} from "@/components/epic-canvas/comm-graph/office/office-bench";

import {
  OFFICE_VIEWS,
  type OfficePlanInput,
} from "@/lib/comm-graph/office/views/office-view";
import { OFFICE_VIEW_CHOICES } from "@/lib/comm-graph/office/office-view-vocabulary";
import { __setCommGraphCloudSubscriptionOpenerForTests } from "@/lib/comm-graph/comm-graph-opener-override";
import type { CommGraphSubscriptionHandlers } from "@/lib/comm-graph/comm-graph-subscription";
import type {
  CommGraphCloudSubscriptionHandlers,
  CommGraphCloudSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-cloud-subscription";
import type {
  EpicCommunicationGraphEvent,
  HostCommunicationGraphCloudFeedEvent,
} from "@traycer/protocol/host/epic/communication-graph";
import { useAuthStore } from "@/stores/auth/auth-store";
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
import { __resetCommGraphCloudRegistryForTests } from "@/lib/comm-graph/comm-graph-cloud-registry";

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
const PROFILE = { userId: "user-1", userName: "U", email: "u@example.com" };
const CONTEXT = { userId: "user-1", username: "U" };

const harness = createEpicSessionTestHarness(EPIC_ID);
let queryClient: QueryClient;

/**
 * There is ONE relay per epic now, not one dial per origin host. This stays a
 * `Map` keyed by origin host id - the seam every case below drives - but each
 * entry is a thin adapter matching the OLD per-host handler shape, forwarding
 * to the single live relay and stamping its own key on as `originHostId`. The
 * map is populated for BOTH origin hosts at once, the moment the one relay
 * opens (see `beforeEach`), which is what keeps every existing
 * `Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B])`
 * readiness check meaningful unchanged - it now reads "the relay opened",
 * which happens once for both hosts together rather than twice independently.
 */
const relayHandlers: { current: CommGraphCloudSubscriptionHandlers | null } = {
  current: null,
};
const openedByHost = new Map<string, CommGraphSubscriptionHandlers>();
const openRequests: CommGraphCloudSubscriptionRequest[] = [];
let nextIngestVersion = 0;

function toCloudEvent(
  hostId: string,
  event: EpicCommunicationGraphEvent,
): HostCommunicationGraphCloudFeedEvent {
  nextIngestVersion += 1;
  return {
    // Matches the OLD local convention exactly (`commGraphEventKey` prefers
    // `eventId` when present) so every existing `${hostId}:${id}`-shaped test
    // id keeps meaning the same row.
    eventId: `${hostId}:${event.id}`,
    originHostId: hostId,
    originSequence: event.id,
    ingestVersion: nextIngestVersion,
    kind: event.kind,
    capturedAt: event.timestamp,
    senderAgentId: event.senderAgentId,
    receiverAgentId: event.receiverAgentId,
    responseId: event.responseId,
    inReplyTo: event.inReplyTo,
    expectReply: event.expectReply,
    messageText: event.messageText,
    noticeReason: event.noticeReason,
    originKind: event.originKind,
    originChatId: event.originChatId,
    originRefId: event.originRefId,
    historicalUpload: false,
  };
}

function adapterFor(hostId: string): CommGraphSubscriptionHandlers {
  return {
    onSnapshot: (events, headId) => {
      const cloudEvents = events.map((event) => toCloudEvent(hostId, event));
      // The old wire's `null` meant "empty log, no boundary row". The cloud
      // feed's ingest-version counter has no such sentinel - a fresh, empty
      // feed legitimately hands back its current (zero) head - so an empty
      // delivery still stamps a real, present boundary.
      void headId;
      const headVersion =
        cloudEvents.length === 0
          ? nextIngestVersion
          : Math.max(
              ...cloudEvents.map((cloudEvent) => cloudEvent.ingestVersion),
            );
      relayHandlers.current?.onSnapshot(cloudEvents, headVersion, null);
      // The old per-host boundary considered a delivered snapshot immediately
      // caught up (`initialHistoryCaughtUp` in the local manager derives this
      // from boundary+cursor alone - no separate signal). The cloud manager
      // instead needs an explicit "caught up" wire frame, distinct from the
      // snapshot itself - so this adapter fires it right behind the
      // snapshot, preserving what every existing call site already means:
      // "this host handed over its history, in full, in one shot".
      const caughtUpEvent = cloudEvents.find(
        (cloudEvent) => cloudEvent.ingestVersion === headVersion,
      );
      relayHandlers.current?.onCaughtUp(
        caughtUpEvent === undefined
          ? null
          : {
              ingestVersion: caughtUpEvent.ingestVersion,
              eventId: caughtUpEvent.eventId,
            },
        headVersion,
      );
    },
    onEvent: (event) => {
      relayHandlers.current?.onEvent(toCloudEvent(hostId, event));
    },
    onStatus: (status) => {
      relayHandlers.current?.onStatus(status);
    },
  };
}

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
 * Every agent predates `Chat.hostId` / `TuiAgent.hostId` - a fully legacy
 * epic, never attributed to any host, unlike `seedDoc`'s mix. `useCommGraphAgents`
 * excludes a null `hostId` from `hostIds`, so this fixture drives that set to
 * empty while still populating real, drawable agents (Finding 38).
 */
function seedAllHostlessDoc(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();

  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ID);
  chat.set("title", "Orchestrator");
  chat.set("parentId", null);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  chat.set("messages", new Y.Array<unknown>());
  chats.set(CHAT_ID, chat);

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
  tuiAgents.set(TUI_ID, tui);

  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", tuiAgents);
  epic.set("chats", chats);
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

/**
 * The tile box every case below stubs when it wants the office drawn at a
 * workaday size - and, for the cases that read Auto's answer, the box on which
 * this fixture reaches the Floor.
 *
 * GEOMETRY, RE-MEASURED, AND WITH THE MARGIN NAMED. This was `1040x700`, on
 * which the fixture fit the Floor at **0.717x** against an
 * `OFFICE_LOD_OFFICE_ZOOM` of `0.7`. That is one tile of height in hand across
 * the whole stack - this epic's four agents sit on three floors (`host-a` x2,
 * the unattributed legacy chat, `host-b`), so the Floor's world was 688x976px
 * and the budget was 1000px - and any change to any plan would have spent it.
 * The civic rooms spent it: 704x1264px, **0.554x**, and Auto answered Towers.
 *
 * At `1040x1000` the same fixture fits at **0.791x**, which is 13% of margin
 * rather than 2%. Whoever grows the Floor next is spending that, and should
 * re-measure here rather than discover it as fifteen red cases.
 *
 * Deliberately not fixed by making the fixture single-host, which would be
 * roomier still (704x400, 1.477x): the fifteen cases that read Auto's answer
 * all gate on BOTH hosts having subscribed, `markHistoryCaughtUp` drives both
 * snapshots, and "does not run while the snapshot is a partial one" has no
 * meaning at all with one host to be partial about.
 */
const OFFICE_CANVAS = { width: 1040, height: 1000 };

/**
 * The world box the persisted camera `{x: -10000, y: -20000, zoom: 4}` frames
 * on an `OFFICE_CANVAS` tile - what the four "the runtime kept the persisted
 * framing" cases below assert, and the one thing in them that the canvas box
 * decides. `x`/`y` come from the camera (`10000/4`, `20000/4`); the extent is
 * the box over the zoom, so it is read off `OFFICE_CANVAS` rather than written
 * out, and growing that box moves it instead of reddening four cases whose
 * claim has nothing to do with how big the tile is.
 */
const PERSISTED_CAMERA_FRAME = {
  x: 2500,
  y: 5000,
  width: OFFICE_CANVAS.width / 4,
  height: OFFICE_CANVAS.height / 4,
};

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
 * Reaches the office resolved to Floor - the app's default - through the
 * real store and the real canvas: the state every pick below starts from.
 *
 * There is no measurement step to wait on any more: `resolvedViewId` is
 * `officeView ?? settingsDefaultView`, decided at render, so the picker
 * already shows "Floor" the instant the canvas mounts and subscribes.
 */
async function reachFloor(): Promise<void> {
  await renderOfficeTile();
  await waitFor(() => {
    expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]);
  });
  setIntersecting(true);
  setOfficeCanvasSize(OFFICE_CANVAS);
  await waitFor(() => {
    expect(
      screen.getByTestId("comm-graph-office-view-picker").textContent,
    ).toBe("Floor");
  });
}

/**
 * Picks a view through the REAL picker - the dropdown a person opens and the
 * radio item they click - and settles the canvas that results.
 *
 * Shared by the switch cases and the bench, which both need a scene in hand:
 * a pick is what puts one there.
 */
async function pickView(viewId: OfficeViewChoice): Promise<void> {
  openPicker();
  await act(async () => {
    fireEvent.click(screen.getByTestId(`comm-graph-office-view-${viewId}`));
    await Promise.resolve();
  });
  setIntersecting(true);
  setOfficeCanvasSize(OFFICE_CANVAS);
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Picks a choice through the REAL picker without settling a scene afterwards
 * - the synchronous half of `pickView` above, for cases that need to inspect
 * what the pick's own write did BEFORE anything else runs.
 */
function chooseView(choice: OfficeViewChoice): void {
  openPicker();
  fireEvent.click(screen.getByTestId(`comm-graph-office-view-${choice}`));
}

/**
 * Opens the comm-graph tile through the REAL canvas store, on its own
 * default view (office mode, `officeView: null`, so the effective choice is
 * Settings' default of `"floor"`).
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
  relayHandlers.current = null;
  nextIngestVersion = 0;
  useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  activeObserverCallbacks = [];
  vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  harness.install(seedDoc, "owner");
  __setCommGraphCloudSubscriptionOpenerForTests((request) => {
    openRequests.push(request);
    relayHandlers.current = request.handlers;
    // ONE relay serves every origin host at once - both keys populate
    // together, the instant it opens.
    openedByHost.set(HOST_A, adapterFor(HOST_A));
    openedByHost.set(HOST_B, adapterFor(HOST_B));
    return { close: () => undefined };
  });
});

afterEach(() => {
  // Unmount BEFORE the auth store flips: a tile left mounted while auth
  // changes re-renders and re-claims the relay through the change, redialing
  // for no assertion left to see it.
  cleanup();
  __setCommGraphCloudSubscriptionOpenerForTests(null);
  useAuthStore.getState().setSignedOut();
  harness.teardown();
  queryClient.clear();
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
  // THE SAME BOX THE CASES ASK FOR, not the historical `1040x700`.
  //
  // A probe taken BEFORE a case calls `setOfficeCanvasSize` carries whatever
  // this default says, and Auto latches its first answer - it does not
  // re-measure once an outcome is written. At `1040x700` this fixture fits the
  // Floor at 0.52 against a 0.7 threshold, so such a probe answered Towers and
  // kept it, which is a real box and so sails past the probe's `width <= 0`
  // guard. That cost about one CI run in three in `shard 14` and never
  // reproduced locally, because whether the resize has propagated before the
  // catch-up opens Auto's gate is an interleaving question.
  //
  // Sized off `OFFICE_CANVAS` rather than repeating its numbers, so raising the
  // box the cases use raises this with it instead of re-opening the gap.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, OFFICE_CANVAS.width, OFFICE_CANVAS.height),
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
function statusMapOfSync(
  spy: SpiedCalls,
): ReadonlyMap<string, OfficeAgentStatus> {
  const input = spy.mock.calls.at(-1)?.[0];
  if (typeof input !== "object" || input === null) {
    throw new Error("expected a scene sync");
  }
  if (!("statusById" in input)) {
    throw new Error("expected a scene input");
  }
  const map = input.statusById;
  if (!(map instanceof Map)) {
    throw new Error("expected a status map");
  }
  return map;
}

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
): {
  readonly frame: OfficeRect;
  readonly view: OfficeViewId;
  readonly world: OfficeSize;
  readonly bounds: OfficeRect;
} {
  const frame = frames.mock.calls.at(-1)?.[1];
  const scene = sync.mock.contexts.at(-1);
  if (!isOfficeRect(frame) || !(scene instanceof OfficeScene)) {
    throw new Error("no real scene frame");
  }
  const layout = scene.layout();
  if (layout === null) throw new Error("no layout");
  return {
    frame,
    view: layout.view,
    world: scene.worldSize(),
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
 * boundary faked (`__setCommGraphCloudSubscriptionOpenerForTests`).
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

  it("opens one relay subscription covering every host the epic's agents reference", async () => {
    await renderTile();

    await waitFor(() => {
      expect(Array.from(openedByHost.keys()).sort()).toEqual([HOST_A, HOST_B]);
    });
    expect(openRequests).toHaveLength(1);
    for (const request of openRequests) {
      expect(request.epicId).toBe(EPIC_ID);
      expect(request.readSinceCursor()).toBeNull();
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

  // ONE relay serves every origin host now, so a degraded transport status
  // is never independent per host - the manager stamps it onto every origin
  // host's snapshot uniformly (`CommGraphCloudSubscriptionManager.publish`).
  // This replaces two prior cases, one per status, that each asserted a
  // status landing on ONLY one origin host's agents while the other host's
  // agents stayed unaffected ("degrade is per subscription") - that per-host
  // independence no longer exists to assert.
  it.each(["unsupported", "unreachable"] as const)(
    "stamps a uniform %s status on agents from every origin host via data-host-status, without captioning either node",
    async (status) => {
      await renderTile();
      await waitFor(() => {
        expect(openedByHost.has(HOST_B)).toBe(true);
      });

      act(() => {
        openedByHost.get(HOST_A)?.onStatus(status);
        // Two origin hosts fall back to two relay CANDIDATES here (no
        // directory is mocked in this file), and the manager fails over
        // through them one at a time on rejection - synchronously, within
        // this same call. The failover redial's fresh dial starts back at
        // "connecting", so the second candidate needs driving too, or the
        // status reverts to "connecting" instead of sticking.
        relayHandlers.current?.onStatus(status);
      });

      await waitFor(() => {
        expect(
          screen
            .getByTestId(`comm-graph-node-${TUI_ID}`)
            .getAttribute("data-host-status"),
        ).toBe(status);
      });
      // Feed degradation is feed health, not agent state - no caption on the
      // node either host's agent renders through.
      expect(
        screen.queryByTestId(`comm-graph-node-notice-${TUI_ID}`),
      ).toBeNull();
      expect(
        screen
          .getByTestId(`comm-graph-node-${CHAT_ID}`)
          .getAttribute("data-host-status"),
      ).toBe(status);
      expect(
        screen.queryByTestId(`comm-graph-node-notice-${CHAT_ID}`),
      ).toBeNull();
    },
  );

  describe("immediate office rendering (no measurement step)", () => {
    // Auto's decision arithmetic and its persisted outcome (`officeAutoView`)
    // are gone: `resolvedViewId` is `officeView ?? settingsDefaultView`,
    // decided synchronously at render, so the office renders the resolved
    // view the instant the canvas mounts - there is no "measuring..." stage
    // to gate on, and no feed catch-up to wait for either.
    it("resolves and draws Floor - the app's default - before the tile is even intersecting or sized", async () => {
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });

      // No `setIntersecting`, no `setOfficeCanvasSize`, no snapshot delivered
      // yet - the old Auto gate needed every one of those before it would
      // even measure. The resolved view is a fact about `officeView` and the
      // Settings default alone, so the picker already names it.
      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Floor");
      expect(storedView()?.officeView).toBeNull();
    });

    it("draws the office before the feed has caught up - readiness never waited on Auto's measurement", async () => {
      await renderOfficeTile();
      await waitFor(() => {
        expect(Array.from(openedByHost.keys()).sort()).toEqual([
          HOST_A,
          HOST_B,
        ]);
      });
      setIntersecting(true);
      setOfficeCanvasSize(OFFICE_CANVAS);

      // No `onSnapshot` for either host - the feed is deliberately left
      // uncaught-up - yet the canvas is already up and the picker already
      // resolved, because `ready` is `agents.length > 0 && mode === "office"`
      // now, independent of `initialHistoryCaughtUp`.
      await waitFor(() => {
        expect(screen.getByTestId("comm-graph-office-canvas")).toBeDefined();
      });
      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Floor");
    });

    it("resolves a hostless epic the same way - there is no host-emptiness special case left to prove (Finding 38, superseded)", async () => {
      // The old `isFeedSettled` short-circuit that treated an empty host set
      // as pre-settled existed only to unblock Auto's measurement gate on a
      // fully legacy epic. That gate is gone, so a hostless epic needs no
      // special case at all: it resolves and draws exactly like any other.
      harness.teardown();
      harness.install(seedAllHostlessDoc, "owner");

      await renderOfficeTile();
      await waitFor(() => {
        expect(screen.getByTestId("comm-graph-office-canvas")).toBeDefined();
      });
      expect(Array.from(openedByHost.keys())).toEqual([]);

      setIntersecting(true);
      setOfficeCanvasSize(OFFICE_CANVAS);

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Floor");
    });

    it("still resolves to Floor after a mode round trip - there is no measurement pass left to repeat or skip", async () => {
      await reachFloor();

      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Floor");
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
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
      );

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Building");
      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeView: null,
      });
    });

    it("leaves an explicitly picked tile unchanged when Settings default changes", async () => {
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "campus",
        x: 25,
        y: 40,
        zoom: 2,
      });
      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Campus");

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
      );

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe("Campus");
      expect(storedView()).toMatchObject({
        officeView: "campus",
        x: 25,
        y: 40,
        zoom: 2,
      });
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
      useSettingsStore.getState().setAgentOfficeDefaultView("building");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: "floor",
      });

      await waitFor(() =>
        expect(
          screen.getByTestId("comm-graph-office-view-picker").textContent,
        ).toBe("Building"),
      );
      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeCameraView: "building",
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
      await reachFloor();

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
      expect(storedView()?.officeCamera).not.toBeNull();
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
          .setAgentOfficeDefaultView(kind === "mounted" ? "floor" : "building");
        // D68: the camera the office runtime actually reads is
        // `officeCamera`, not the top-level fields (the graph's now) -
        // seeded there so this is a real test of the runtime this ticket is
        // about, not of a field nothing reads in office mode.
        await renderSeededOfficeInLoadedSession({
          ...DEFAULT_COMM_GRAPH_VIEW,
          officeCamera: { x: -10000, y: -20000, zoom: 4 },
          officeCameraView: "floor",
        });
        setOfficeCanvasSize(OFFICE_CANVAS);
        setIntersecting(true);
        caughtUp();
        step();
        if (kind === "mounted") {
          // The default moves WHILE this tile watches - the case the effect
          // itself witnesses.
          act(() =>
            useSettingsStore.getState().setAgentOfficeDefaultView("building"),
          );
          setOfficeCanvasSize(OFFICE_CANVAS);
          setIntersecting(true);
          step();
        }
        // "unmounted" needs no further action: the tile mounted AFTER the
        // default already moved, so the record disagreeing at render is the
        // only evidence there ever was.

        const cameraBeforePan = storedView();
        expect(cameraBeforePan).toMatchObject({
          officeCamera: null,
          officeCameraView: "building",
        });
        // The ACTUAL claim: the runtime's own frame, built from whatever
        // camera the replacement canvas actually started with, has to
        // contain the Building world it is supposedly showing - not a Floor
        // camera's numbers reinterpreted as Building.
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
        expect(storedView()?.officeCameraView).toBe("building");
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
      setOfficeCanvasSize(OFFICE_CANVAS);
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
      expect(state.frame).toEqual(PERSISTED_CAMERA_FRAME);
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
      setOfficeCanvasSize(OFFICE_CANVAS);
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
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
      );
      setOfficeCanvasSize(OFFICE_CANVAS);
      setIntersecting(true);
      step();

      // A genuinely different view is a genuinely different canvas
      // instance, same as every other reset in this ticket.
      expect(screen.getByTestId("comm-graph-office-canvas")).not.toBe(
        beforeElement,
      );
      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeCameraView: "building",
      });
      // The ACTUAL claim: the runtime's own frame has to contain the
      // Building world it is supposedly showing - not a Floor camera's
      // numbers reinterpreted as Building, which is exactly what a witness
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
      // not the stale Floor framing carried forward and re-stamped Building.
      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 20,
        deltaY: 30,
      });
      step();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      });
      expect(storedView()).toMatchObject({ officeCameraView: "building" });
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
      setOfficeCanvasSize(OFFICE_CANVAS);
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      expect(state.frame).toEqual(PERSISTED_CAMERA_FRAME);
    });

    it("keeps a legacy camera when the default already moved before the tile ever mounted (accepted gap, D52)", async () => {
      // Nothing witnessed this move - the default was already `building` by
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
      useSettingsStore.getState().setAgentOfficeDefaultView("building");
      await renderSeededOfficeInLoadedSession({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      setOfficeCanvasSize(OFFICE_CANVAS);
      setIntersecting(true);
      caughtUp();
      step();

      const state = lastFrameAndBounds(frames, sync);
      expect(storedView()).toMatchObject({
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
        officeCameraView: null,
      });
      expect(state.frame).toEqual(PERSISTED_CAMERA_FRAME);
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
      setOfficeCanvasSize(OFFICE_CANVAS);
      setIntersecting(true);
      caughtUp();
      step();

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
      );
      setOfficeCanvasSize(OFFICE_CANVAS);
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
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
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
      useSettingsStore.getState().setAgentOfficeDefaultView("building");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        x: 155,
        y: 266,
        zoom: 2,
        // Stale: framed under Floor while Office (unseen, since Graph is
        // active) now resolves to Building via the changed default.
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
      await reachFloor();

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

  describe("flushing a pending office framing across a mode switch (Codex 4011701267)", () => {
    it("folds a pending, still-debounced office pan into the same write that flips the mode, instead of losing it when the canvas unmounts", async () => {
      // The office camera persist is debounced 150ms; a wheel right before
      // switching to Graph is still PENDING when the switch unmounts the
      // office canvas, and that unmount cancels the timer - correct for a
      // view-pick remount, wrong here, since D68 promises a mode switch
      // keeps each renderer's camera. No `await`/timer advance between the
      // wheel and the click: the claim is about catching the write BEFORE
      // the debounce has any chance to fire on its own.
      await reachFloor();
      expect(storedView()?.officeCamera).toBeNull();

      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 80,
        deltaY: 90,
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-graph"));
        await Promise.resolve();
      });

      expect(storedView()?.mode).toBe("graph");
      // RED pre-fix: `officeCamera` stays `null` - the pending pan never
      // reaches the store, dropped along with the cancelled timer.
      expect(storedView()?.officeCamera).not.toBeNull();
      expect(storedView()?.officeCameraView).toBe("floor");
    });

    it("still drops a pending pan when a genuine VIEW PICK remounts the canvas within the debounce window (guard - unaffected by the mode-switch flush)", async () => {
      // Codex's fix folds the pending framing in ONLY on a mode switch;
      // `onRegisterFlush` is never consulted by a view pick, so this
      // pre-existing drop (a pan on the OLD view has no business landing on
      // the new one) must survive untouched.
      await reachFloor();

      fireEvent.wheel(screen.getByTestId("comm-graph-office-canvas"), {
        deltaX: 80,
        deltaY: 90,
      });
      await pickView("building");

      expect(storedView()?.officeView).toBe("building");
      expect(storedView()?.officeCameraView).toBe("building");
      expect(storedView()?.officeCamera).toBeNull();
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
    // that matters is the one still ahead), `officeView: null` (a followed
    // default, nothing pinned), a camera that has never addressed
    // "building" at all (`{ x: -10000, y: -20000, zoom: 4 }`), and - the
    // detail that makes this the Graph-mode variant of the finding -
    // `officeCameraView: "building"` ALREADY on the record, for reasons
    // that have nothing to do with the move about to happen (the tile
    // could have been saved under a Settings default of Building long
    // before this move ever happened).
    function seededTile(): CommGraphTileViewState {
      return {
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        officeView: null,
        officeCameraView: "building",
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
      };
    }

    it("keeps the witness armed through a mode switch when the record already names the arriving view", async () => {
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice(seededTile());
      expect(storedView()?.mode).toBe("graph");

      // THE ARMING MOVE: the default moves floor -> building while Graph is
      // still up. Both reset effects return early outside office mode, so
      // this writes NOTHING to the store - the only trace it leaves is the
      // witness, which arms on the stored view object as it stands right
      // now (`officeCameraView: "building"` already, camera still the stale
      // one seeded above).
      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
      );

      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      // THE RELEASING WRITE: a plain mode switch. `handleModeChange` writes
      // a new view object carrying the SAME `officeCameraView: "building"` it
      // already had - which is exactly the pre-existing match the release
      // predicate mistakes for a writer that has just spoken FOR "building".
      await act(async () => {
        fireEvent.click(screen.getByTestId("comm-graph-mode-office"));
        await Promise.resolve();
      });

      // ASSERTION 1: the office runtime has to be BUILT neutral. A released
      // witness hands the canvas the stale `{-10000, -20000, 4}` on its
      // very first render - the camera never had anything to do with
      // Building, and `createOfficeRuntime` only ever reads this once.
      expect(lastCanvasCamera(office)).toMatchObject({ x: 0, y: 0, zoom: 1 });

      await act(async () => {
        await Promise.resolve();
      });

      // ASSERTION 2: THE STORE IS SETTLED TOO. Reset effect 1 declines to
      // fire because the record already names "building" - so today the
      // projection would be neutral (once assertion 1 holds) while the
      // STORE keeps the stale camera, and a reload before the office
      // happens to pan hands it straight back with the record still
      // vouching for it.
      expect(storedView()).toMatchObject({
        officeCamera: null,
        officeCameraView: "building",
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
      useSettingsStore.getState().setAgentOfficeDefaultView("floor");
      await renderSeededOffice(seededTile());
      expect(storedView()?.mode).toBe("graph");

      act(() =>
        useSettingsStore.getState().setAgentOfficeDefaultView("building"),
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
        officeCameraView: "building",
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
      // the resolved view is already "building" when the tile mounts and
      // stays "building" throughout, so the witness never arms in the first
      // place - there is nothing here for the fix above to release
      // wrongly, or to hold rightly. This is exactly the case D68 added a
      // per-renderer camera to protect (a mode switch is not a camera
      // event), and the fix for the finding above must leave it alone:
      // expected GREEN both before this fixup and after it.
      useSettingsStore.getState().setAgentOfficeDefaultView("building");
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
        officeCameraView: "building",
      });
    });
  });

  describe("an explicit pick sees nothing left to preserve once the default resolves to something concrete (fixup 12, pick-arm timing)", () => {
    // The pick sibling has its own preservation arm: `next ===
    // resolvedViewId ? node.view.officeCamera : null`. To exercise it with a
    // witnessed move actually held, `resolvedViewId` has to stay CONCRETE
    // the whole time (there is no unresolved state left to route through
    // now that every choice is a real view), so this arms the witness on
    // building -> campus, both concrete.
    //
    // The reason this is expected to come back GREEN rather than red:
    // whenever `resolvedViewId` is concrete, the record/witness reset
    // effect is never blocked, and - since D68/fixup 12 - it carries NO
    // mode gate either. So it retires the stale camera and releases the
    // witness the moment the default move resolves, whether Graph or
    // Office is on screen, well before any pick could ever see an armed
    // witness sitting over a non-null camera. The pick arm is unreachable
    // by TIMING here - the other effect always wins the race - not because
    // the arm itself knows to decline a witnessed camera.
    it("an explicit pick of the already-resolved view finds nothing left to preserve (pick sibling) - green by timing, not by rule", async () => {
      useSettingsStore.getState().setAgentOfficeDefaultView("building");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph",
        officeView: null,
        officeCameraView: "building",
        officeCamera: { x: -10000, y: -20000, zoom: 4 },
      });
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
      // already showing - exercises the pick sibling's own keep arm.
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

  describe("readiness classification (F3, revised by fixup 8/H1)", () => {
    it("plans a restored Building before replay is ready (fixup 8 draws it), and still classifies its cold arrival as hot once replay confirms it awaiting", async () => {
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      const plan = vi.spyOn(OFFICE_VIEWS.building, "plan");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
      });
      setOfficeCanvasSize(OFFICE_CANVAS);
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
      setOfficeCanvasSize(OFFICE_CANVAS);
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
    it("hands the canvas ready:true and lets the real Building planner run before the feed catches up", async () => {
      const office = vi.spyOn(officeCanvasModule, "CommGraphOfficeCanvas");
      const plan = vi.spyOn(OFFICE_VIEWS.building, "plan");
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
      });
      setIntersecting(true);
      setOfficeCanvasSize(OFFICE_CANVAS);
      // Deliberately no `caughtUp()` here - this IS the H1 reproduction: the
      // local server lost its database mid-sitting and the feed never
      // caught up, and an explicit Building tile drew nothing for 25 minutes
      // while the Graph beside it drew every node from the same snapshot.
      // This is a standalone assertion on purpose, reachable only through
      // the prop the canvas was actually HANDED - a suite that only checked
      // the planner ran (below) could still be fooled by a `ready` wired to
      // something other than what fixup 8 changed.
      expect(lastCanvasReady(office)).toBe(true);
      // And the canvas acted on it for real: the actual Building planner ran
      // against the loaded snapshot, not merely a prop nobody consumed.
      expect(plan).toHaveBeenCalled();
    });

    it("letters a drawn office that is still behind its feed with no status line at all", async () => {
      // THE CHIP THIS USED TO PIN IS GONE, asked for by name in feedback
      // round 2: "why do we still have this Catching up label above the zoom
      // buttons? We were supposed to remove all those labels!". The wait it
      // described is real - the floor draws from the agent list and fills in
      // who is BUSY as the feed replays - and the ruling is that it is not
      // worth a sentence of chrome over a drawing that is already on screen
      // and already settling.
      //
      // Kept as a case rather than deleted with the chip, from the state that
      // WOULD have shown it (a drawn Building tile, feed still replaying): the
      // absence is the decision, and an absence nothing asserts is an
      // invitation to put it back.
      await renderSeededOffice({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
      });
      setIntersecting(true);
      setOfficeCanvasSize(OFFICE_CANVAS);

      expect(
        screen.queryByTestId("comm-graph-office-catching-up-chip"),
      ).toBeNull();
      expect(screen.queryByText(/catching up/i)).toBeNull();
      // ANTI-VACUITY: the office really mounted, so "no chip" is a fact about
      // this tile and not about a render that never got there.
      expect(screen.getByTestId("comm-graph-office-zoom-in")).toBeDefined();

      // And it stays absent through the transition it used to be cleared by.
      caughtUp();
      expect(screen.queryByText(/catching up/i)).toBeNull();
    });
  });

  describe("picking a view", () => {
    it("picking the already-resolved view records the choice without moving the camera", async () => {
      // `handleOfficeViewChange` used to compare `next` against the STORED
      // `officeView`, which is null on a tile still following the Settings
      // default - so picking the view already on screen fell through to the
      // camera reset and threw the person's framing away. It now compares
      // against the RESOLVED view.
      await reachFloor();
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
      await reachFloor();
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
      fireEvent.click(screen.getByTestId("comm-graph-office-view-building"));

      expect(storedView()?.officeView).toBe("building");
      expect(storedView()?.officeCamera).toBeNull();
    });

    it("adopts every offered view with exactly one canvas, never a stale second one (F7)", async () => {
      const sync = vi.spyOn(OfficeScene.prototype, "sync");
      await reachFloor();
      let beforeId: OfficeViewChoice = "floor";
      for (const id of OFFICE_VIEW_CHOICES) {
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

        setOfficeCanvasSize(OFFICE_CANVAS);
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
        beforeId = id;
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
    const VIEW_CYCLE: ReadonlyArray<OfficeViewChoice> = [
      "building",
      "campus",
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

    it("reaches every offered view, and the picker says which one it is on", async () => {
      await reachFloor();

      for (const viewId of OFFICE_VIEW_CHOICES) {
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
      const syncSpy = vi.spyOn(OfficeScene.prototype, "sync");
      await reachFloor();
      expect(scenesSeen(syncSpy)).toBe(1);

      // Floor is already on screen (the app's default); pinning it writes
      // the choice without changing the view, so the canvas's key does not
      // move and the scene in hand is the one that stays.
      await pickView("floor");
      expect(scenesSeen(syncSpy)).toBe(1);

      await pickView("building");

      // A different view is a different office: a new canvas, and with it a
      // new scene, rather than the Floor's scene handed a Building layout.
      expect(scenesSeen(syncSpy)).toBe(2);
    });

    it("leaves exactly one scene alive after ten Floor, Building, Campus rounds", async () => {
      await reachFloor();
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
        setOfficeCanvasSize(OFFICE_CANVAS);
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
        await reachFloor();
        // Pinning the view already resolved (the app's default) is what puts
        // a scene in hand here: it writes the choice without moving the
        // canvas's key, and the scene syncs on the input that follows. The
        // same step the switch cases above take for the same reason.
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

    it("advances a scripted bench onto the scene through the timer, not a pinned hook", async () => {
      // GAP B: every bench case consumes maps or step numbers, so
      // `useOfficeBenchScriptStep` stuck at 0 escapes all of them. This
      // reads the map the SCENE received after the real timeout, on the
      // tile that actually draws a benched office.
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
      });
      const restore = benchAt("?officeBench=40&officeBenchScript=outbreak");
      const synced = vi.spyOn(OfficeScene.prototype, "sync");
      try {
        await reachFloor();
        await pickView("floor");
        await waitFor(() => {
          expect(synced.mock.calls.length).toBeGreaterThan(0);
        });
        const request = parseOfficeBenchSearch(window.location.search);
        if (request === null) {
          throw new Error("expected a scripted bench in the URL");
        }
        const bench = officeBench(request);
        const crashers: string[] = [];
        for (const [id, status] of bench.steps[1]) {
          if (status === "failure") crashers.push(id);
        }
        expect(crashers.length).toBeGreaterThan(0);
        const crasherHost = bench.agents.find(
          (agent) => agent.id === crashers[0],
        )?.hostId;
        const resting = statusMapOfSync(synced);
        // PRECONDITION, not the red: at triage/40 the fixture happens to
        // put no `failure` on this host, so this loop is green at base.
        // The red is the timer advancing the scene onto step 1 below.
        for (const agent of bench.agents) {
          if (agent.hostId !== crasherHost) continue;
          expect(resting.get(agent.id)).not.toBe("failure");
        }

        await act(async () => {
          vi.advanceTimersByTime(OFFICE_BENCH_SCRIPT_STEP_MS);
          await Promise.resolve();
        });
        await waitFor(() => {
          const after = statusMapOfSync(synced);
          expect(after.get(crashers[0])).toBe("failure");
        });
        const after = statusMapOfSync(synced);
        for (const id of crashers) {
          expect(after.get(id)).toBe("failure");
        }
      } finally {
        vi.useRealTimers();
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
      setOfficeCanvasSize(OFFICE_CANVAS);
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getAllByTestId(/^comm-graph-office-agent-/)).toHaveLength(
        4,
      );
    });
  });
});
