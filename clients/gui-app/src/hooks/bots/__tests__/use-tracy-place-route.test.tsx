import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type UseNavigateResult,
  type RouterHistory,
} from "@tanstack/react-router";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import {
  normalizeTracyPlaceSearch,
  tracyPlaceOfSearch,
  tracyPlaceRailOf,
  type TracyChannelView,
  type TracyPlace,
  type TracyPlaceSession,
} from "@/lib/bots/tracy-place";
import { observeTracyPlaceTraversals } from "@/lib/bots/tracy-place-traversal";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import { isHistoryEntryDead } from "@/lib/history-navigation/liveness";
import { isHistoryEntryEligible } from "@/lib/history-navigation/eligibility";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  TracyChannelPlaceRoute,
  TracySurfacePlaceRoute,
} from "@/routes/tracy-route-components";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  exchangeRailOver,
  memoryRailOver,
  searchRailOver,
  useBotOpenThreadStore,
  type BotOpenThread,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import {
  tracySessionOf,
  tracyViewOf,
  useTracyPlaceStore,
} from "@/stores/bots/tracy-place-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

/**
 * The Tracy surface's place (view, Threads, a session, the rail's thread,
 * memory and pair's log) mirrored onto the route, on a real router and the
 * real `TabNavigationRouteBridge`: a move of the person's is a history step,
 * Back and Forward put the surface where the entry says.
 */

const WINDOW_HOST = "host-window";
const BOT_A = "bot-a";
const BOT_B = "bot-b";

interface Harness {
  readonly history: RouterHistory;
  readonly navigate: UseNavigateResult<string>;
  /** Where the router is: its path, its search and its entry's index. */
  readonly location: () => {
    readonly pathname: string;
    readonly search: Readonly<Record<string, unknown>>;
    readonly index: number;
  };
}

function buildRouter(history: RouterHistory) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TabNavigationRouteBridge />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const tracyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot",
    validateSearch: normalizeTracyPlaceSearch,
    component: TracySurfacePlaceRoute,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    validateSearch: normalizeTracyPlaceSearch,
    component: TracyChannelPlaceRoute,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tracyRoute, channelRoute]),
    history,
  });
}

let stopObserving: () => void = () => undefined;

async function mount(initialEntries: ReadonlyArray<string>): Promise<Harness> {
  const router = buildRouter(
    createMemoryHistory({ initialEntries: [...initialEntries] }),
  );
  stopObserving = observeTracyPlaceTraversals(router.history);
  render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  return {
    history: router.history,
    navigate: router.navigate,
    location: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search,
      index: router.state.location.state.__TSR_index,
    }),
  };
}

function resetStores(): void {
  window.localStorage.clear();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
    goneReports: {},
  });
  useTracyPlaceStore.setState(useTracyPlaceStore.getInitialState(), true);
  useBotOpenThreadStore.setState(useBotOpenThreadStore.getInitialState(), true);
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
  useBotTabLandingStore.setState(useBotTabLandingStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({
    attached: true,
    effectiveHostId: WINDOW_HOST,
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  tabCommandCoordinator.resetReconciliationForTesting();
  __resetTabNavigationControllerForTesting();
}

/** What the surface's stores hold for one channel. */
interface Surface {
  readonly view: TracyChannelView;
  readonly threadsShown: boolean;
  readonly session: TracyPlaceSession | null;
  readonly rail: BotRail | null;
}

const NOTHING: Surface = {
  view: "messages",
  threadsShown: false,
  session: null,
  rail: null,
};

function railOf(botId: string): BotRail | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  return Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
}

function surfaceOf(botId: string): Surface {
  const place = useTracyPlaceStore.getState();
  return {
    view: tracyViewOf(place.viewByBotId, botId),
    threadsShown: place.threadsShown,
    session: tracySessionOf(place.sessionByBotId, botId),
    rail: railOf(botId),
  };
}

/** The place the URL carries when the surface is `surface`. */
function placeOf(surface: Surface): TracyPlace {
  return {
    view: surface.view,
    threadsShown: surface.threadsShown,
    session: surface.session,
    ...tracyPlaceRailOf(surface.rail),
  };
}

/** Puts the stores of `botId` where `surface` says, in one batch. */
function establish(botId: string, surface: Surface): void {
  act(() => {
    const place = useTracyPlaceStore.getState();
    place.setView(botId, surface.view);
    place.setThreadsShown(surface.threadsShown);
    place.setSession(botId, surface.session);
    useBotOpenThreadStore.getState().setRail(botId, surface.rail);
  });
}

function thread(
  anchorMessageId: string,
  overrides: Partial<BotOpenThread>,
): BotOpenThread {
  return {
    anchorMessageId,
    announcement: false,
    anchorKind: null,
    sent: null,
    ...overrides,
  };
}

function threadRail(
  anchorMessageId: string,
  overrides: Partial<BotOpenThread>,
): BotRail {
  return { kind: "thread", ...thread(anchorMessageId, overrides) };
}

function indexOf(harness: Harness): number {
  return harness.location().index;
}

function urlPlace(harness: Harness): TracyPlace | null {
  return tracyPlaceOfSearch(harness.location().search);
}

async function waitForUrl(
  harness: Harness,
  pathname: string,
  place: TracyPlace,
): Promise<void> {
  await waitFor(() => {
    expect(harness.location().pathname).toBe(pathname);
    expect(urlPlace(harness)).toEqual(place);
  });
}

/** Opens `botId`'s channel as an opener does, and waits for its place to be written. */
async function openChannel(harness: Harness, botId: string): Promise<void> {
  act(() => {
    openBotChannel(harness.navigate, botId, {
      landing: null,
      isConnectable: null,
      onRejected: null,
    });
  });
  await waitForUrl(harness, `/bot/${botId}`, placeOf(NOTHING));
  expect(useTracySurfaceStore.getState().botId).toBe(botId);
}

async function mountOnChannel(botId: string): Promise<Harness> {
  const harness = await mount(["/"]);
  await openChannel(harness, botId);
  return harness;
}

function stepBack(harness: Harness): void {
  act(() => {
    harness.history.back();
  });
}

function stepForward(harness: Harness): void {
  act(() => {
    harness.history.forward();
  });
}

const place = useTracyPlaceStore.getState;
const rails = useBotOpenThreadStore.getState;

interface StepRow {
  readonly name: string;
  readonly start: Surface;
  readonly move: () => void;
  /** The stores right after the move. */
  readonly moved: Surface;
  /**
   * The stores after Back: the entry's place. A search's results are a tool
   * over the place, so they are not restored with it.
   */
  readonly afterBack: Surface;
  /** The stores after Forward: the entry's place, as it restores. */
  readonly restored: Surface;
}

const T1 = threadRail("m-1", {});
const T1_ANSWER = threadRail("m-1", {
  announcement: true,
  anchorKind: "answer",
});
const T2 = threadRail("m-2", {});
const CHAT: TracyPlaceSession = { chatId: "chat-1", threadId: null };
const MEMORY_OVER_T1 = memoryRailOver(T1);
const EXCHANGE_OVER_T1 = exchangeRailOver(T1, "bot-peer");
const EXCHANGE_OVER_MEMORY = exchangeRailOver(MEMORY_OVER_T1, "bot-peer");
const SEARCH_OVER_T1 = searchRailOver(T1);
const SEARCH_HIT: BotRail = {
  kind: "search",
  back: T1,
  showing: { kind: "thread", thread: thread("m-2", {}) },
};

const STEP_ROWS: ReadonlyArray<StepRow> = [
  {
    name: "Messages to Activity",
    start: NOTHING,
    move: () => place().setView(BOT_A, "activity"),
    moved: { ...NOTHING, view: "activity" },
    afterBack: NOTHING,
    restored: { ...NOTHING, view: "activity" },
  },
  {
    name: "Activity to Messages",
    start: { ...NOTHING, view: "activity" },
    move: () => place().setView(BOT_A, "messages"),
    moved: NOTHING,
    afterBack: { ...NOTHING, view: "activity" },
    restored: NOTHING,
  },
  {
    name: "opening the Threads page",
    start: NOTHING,
    move: () => place().setThreadsShown(true),
    moved: { ...NOTHING, threadsShown: true },
    afterBack: NOTHING,
    restored: { ...NOTHING, threadsShown: true },
  },
  {
    name: "leaving the Threads page",
    start: { ...NOTHING, threadsShown: true },
    move: () => place().setThreadsShown(false),
    moved: NOTHING,
    afterBack: { ...NOTHING, threadsShown: true },
    restored: NOTHING,
  },
  {
    name: "opening a thread panel",
    start: NOTHING,
    move: () => rails().setRail(BOT_A, T1),
    moved: { ...NOTHING, rail: T1 },
    afterBack: NOTHING,
    restored: { ...NOTHING, rail: T1 },
  },
  {
    name: "switching to another thread",
    start: { ...NOTHING, rail: T1 },
    move: () => rails().setRail(BOT_A, T2),
    moved: { ...NOTHING, rail: T2 },
    afterBack: { ...NOTHING, rail: T1 },
    restored: { ...NOTHING, rail: T2 },
  },
  {
    name: "closing a thread panel",
    start: { ...NOTHING, rail: T1_ANSWER },
    move: () => rails().setRail(BOT_A, null),
    moved: NOTHING,
    afterBack: { ...NOTHING, rail: T1_ANSWER },
    restored: NOTHING,
  },
  {
    name: "opening the memory over a thread",
    start: { ...NOTHING, rail: T1 },
    move: () => rails().setRail(BOT_A, memoryRailOver(railOf(BOT_A))),
    moved: { ...NOTHING, rail: MEMORY_OVER_T1 },
    afterBack: { ...NOTHING, rail: T1 },
    restored: { ...NOTHING, rail: MEMORY_OVER_T1 },
  },
  {
    name: "closing the memory back to its thread",
    start: { ...NOTHING, rail: MEMORY_OVER_T1 },
    move: () => rails().setRail(BOT_A, T1),
    moved: { ...NOTHING, rail: T1 },
    afterBack: { ...NOTHING, rail: MEMORY_OVER_T1 },
    restored: { ...NOTHING, rail: T1 },
  },
  {
    name: "opening a pair's log over the thread",
    start: { ...NOTHING, rail: T1 },
    move: () =>
      rails().setRail(BOT_A, exchangeRailOver(railOf(BOT_A), "bot-peer")),
    moved: { ...NOTHING, rail: EXCHANGE_OVER_T1 },
    afterBack: { ...NOTHING, rail: T1 },
    restored: { ...NOTHING, rail: EXCHANGE_OVER_T1 },
  },
  {
    name: "opening a pair's log over the memory over a thread",
    start: { ...NOTHING, rail: MEMORY_OVER_T1 },
    move: () =>
      rails().setRail(BOT_A, exchangeRailOver(railOf(BOT_A), "bot-peer")),
    moved: { ...NOTHING, rail: EXCHANGE_OVER_MEMORY },
    afterBack: { ...NOTHING, rail: MEMORY_OVER_T1 },
    restored: { ...NOTHING, rail: EXCHANGE_OVER_MEMORY },
  },
  {
    name: "closing a pair's log back to the memory",
    start: { ...NOTHING, rail: EXCHANGE_OVER_MEMORY },
    move: () => rails().setRail(BOT_A, MEMORY_OVER_T1),
    moved: { ...NOTHING, rail: MEMORY_OVER_T1 },
    afterBack: { ...NOTHING, rail: EXCHANGE_OVER_MEMORY },
    restored: { ...NOTHING, rail: MEMORY_OVER_T1 },
  },
  {
    name: "opening a bot session",
    start: NOTHING,
    move: () => place().setSession(BOT_A, CHAT),
    moved: { ...NOTHING, session: CHAT },
    afterBack: NOTHING,
    restored: { ...NOTHING, session: CHAT },
  },
  {
    name: "closing a bot session",
    start: { ...NOTHING, session: CHAT },
    move: () => place().setSession(BOT_A, null),
    moved: NOTHING,
    afterBack: { ...NOTHING, session: CHAT },
    restored: NOTHING,
  },
  {
    name: "opening a thread from a search hit",
    start: { ...NOTHING, rail: SEARCH_OVER_T1 },
    move: () => rails().setRail(BOT_A, SEARCH_HIT),
    moved: { ...NOTHING, rail: SEARCH_HIT },
    afterBack: { ...NOTHING, rail: T1 },
    restored: { ...NOTHING, rail: T2 },
  },
];

describe("the Tracy surface's place on the route", () => {
  beforeEach(resetStores);
  afterEach(() => {
    stopObserving();
    cleanup();
    resetStores();
  });

  describe("a move of the person's is one history step", () => {
    it.each(STEP_ROWS)("$name", async (row) => {
      const harness = await mountOnChannel(BOT_A);
      establish(BOT_A, row.start);
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(row.start));
      const length = harness.history.length;
      const index = indexOf(harness);

      act(row.move);
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(row.moved));
      expect(surfaceOf(BOT_A)).toEqual(row.moved);
      expect(harness.history.length).toBe(length + 1);
      expect(indexOf(harness)).toBe(index + 1);

      stepBack(harness);
      await waitFor(() => {
        expect(indexOf(harness)).toBe(index);
        expect(surfaceOf(BOT_A)).toEqual(row.afterBack);
      });
      expect(urlPlace(harness)).toEqual(placeOf(row.start));
      expect(harness.history.length).toBe(length + 1);

      stepForward(harness);
      await waitFor(() => {
        expect(indexOf(harness)).toBe(index + 1);
        expect(surfaceOf(BOT_A)).toEqual(row.restored);
      });
      expect(urlPlace(harness)).toEqual(placeOf(row.restored));
      expect(harness.history.length).toBe(length + 1);
    });
  });

  it("pushes the newer place as its own step when the person moves again while the hook's own write is committing", async () => {
    const harness = await mountOnChannel(BOT_A);
    const length = harness.history.length;
    const index = indexOf(harness);
    const first = { ...NOTHING, threadsShown: true };
    const second = { ...first, view: "activity" } as const;
    // The second move lands the instant the first write's entry is pushed,
    // before the router has handed that arrival to the hook.
    let moved = false;
    const unsubscribe = harness.history.subscribe(({ action }) => {
      if (action.type !== "PUSH" || moved) return;
      moved = true;
      act(() => place().setView(BOT_A, "activity"));
    });

    act(() => place().setThreadsShown(true));
    await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(second));
    unsubscribe();

    expect(harness.history.length).toBe(length + 2);
    expect(indexOf(harness)).toBe(index + 2);

    stepBack(harness);
    await waitFor(() => {
      expect(indexOf(harness)).toBe(index + 1);
      expect(surfaceOf(BOT_A)).toEqual(first);
    });
    expect(urlPlace(harness)).toEqual(placeOf(first));
  });

  it("writes the place into the URL's search", async () => {
    const harness = await mountOnChannel(BOT_A);
    act(() => {
      place().setView(BOT_A, "activity");
      rails().setRail(
        BOT_A,
        threadRail("m-1", { announcement: true, anchorKind: "answer" }),
      );
    });
    await waitFor(() => {
      expect(harness.history.location.search).toBe(
        "?view=activity&thread=m-1&threadAnnouncement=true&threadAnchor=answer",
      );
    });
  });

  it("restores a closed thread with its announcement and anchor kind intact", async () => {
    const harness = await mountOnChannel(BOT_A);
    const open = { ...NOTHING, rail: T1_ANSWER };
    establish(BOT_A, open);
    await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(open));

    act(() => rails().setRail(BOT_A, null));
    await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(NOTHING));
    stepBack(harness);

    await waitFor(() => {
      expect(railOf(BOT_A)).toEqual(T1_ANSWER);
    });
  });

  describe("a search is a tool over the place", () => {
    it("adds no entry when its results open over a thread", async () => {
      const harness = await mountOnChannel(BOT_A);
      const open = { ...NOTHING, rail: T1 };
      establish(BOT_A, open);
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(open));
      const length = harness.history.length;
      const writes: string[] = [];
      const unsubscribe = harness.history.subscribe(({ action }) => {
        writes.push(action.type);
      });

      act(() => rails().setRail(BOT_A, searchRailOver(railOf(BOT_A))));
      // A later move of the person's is the barrier: the results' own move
      // had its turn before it, and left nothing.
      act(() => place().setView(BOT_A, "activity"));
      await waitForUrl(
        harness,
        `/bot/${BOT_A}`,
        placeOf({ ...NOTHING, view: "activity", rail: SEARCH_OVER_T1 }),
      );
      unsubscribe();

      expect(writes).toEqual(["PUSH"]);
      expect(harness.history.length).toBe(length + 1);
    });
  });

  describe("a move nobody made by hand", () => {
    it("rewrites the current entry and adds none", async () => {
      const harness = await mountOnChannel(BOT_A);
      act(() => place().setThreadsShown(true));
      await waitForUrl(
        harness,
        `/bot/${BOT_A}`,
        placeOf({ ...NOTHING, threadsShown: true }),
      );
      const length = harness.history.length;
      const index = indexOf(harness);

      act(() => {
        place().markAutomaticMove();
        place().setView(BOT_A, "activity");
      });
      const landed = {
        ...NOTHING,
        threadsShown: true,
        view: "activity",
      } as const;
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(landed));
      expect(harness.history.length).toBe(length);
      expect(indexOf(harness)).toBe(index);

      // The entry behind it is the one before the Threads page was opened.
      stepBack(harness);
      await waitFor(() => {
        expect(indexOf(harness)).toBe(index - 1);
        expect(surfaceOf(BOT_A)).toEqual(NOTHING);
      });
      stepForward(harness);
      await waitFor(() => {
        expect(surfaceOf(BOT_A)).toEqual(landed);
      });
    });

    it("is followed by a move of the person's as a step of its own", async () => {
      const harness = await mountOnChannel(BOT_A);
      act(() => {
        place().markAutomaticMove();
        place().setView(BOT_A, "activity");
      });
      const automatic = { ...NOTHING, view: "activity" } as const;
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(automatic));
      const length = harness.history.length;

      act(() => place().setThreadsShown(true));
      await waitForUrl(
        harness,
        `/bot/${BOT_A}`,
        placeOf({ ...automatic, threadsShown: true }),
      );
      expect(harness.history.length).toBe(length + 1);
    });
  });

  describe("opening another bot's channel", () => {
    it("is one entry, completed with that bot's place, and Back returns to the first bot's place", async () => {
      const harness = await mountOnChannel(BOT_A);
      const activity = { ...NOTHING, view: "activity" } as const;
      act(() => place().setView(BOT_A, "activity"));
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(activity));
      const length = harness.history.length;
      const index = indexOf(harness);

      await openChannel(harness, BOT_B);
      expect(harness.history.length).toBe(length + 1);
      expect(indexOf(harness)).toBe(index + 1);
      // The channel left shows afresh when it is next selected.
      expect(surfaceOf(BOT_A)).toEqual(NOTHING);

      stepBack(harness);
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(activity));
      expect(useTracySurfaceStore.getState().botId).toBe(BOT_A);
      expect(surfaceOf(BOT_A)).toEqual(activity);
      expect(indexOf(harness)).toBe(index);

      stepForward(harness);
      await waitForUrl(harness, `/bot/${BOT_B}`, placeOf(NOTHING));
      expect(useTracySurfaceStore.getState().botId).toBe(BOT_B);
      expect(surfaceOf(BOT_B)).toEqual(NOTHING);
      expect(harness.history.length).toBe(length + 1);
    });

    it("leaves Threads, which the channel left had shown", async () => {
      const harness = await mountOnChannel(BOT_A);
      act(() => place().setThreadsShown(true));
      await waitForUrl(
        harness,
        `/bot/${BOT_A}`,
        placeOf({ ...NOTHING, threadsShown: true }),
      );

      await openChannel(harness, BOT_B);
      expect(place().threadsShown).toBe(false);
    });
  });

  describe("an arrival the app wrote", () => {
    it("is corrected over itself to the place the stores hold, which stand", async () => {
      const harness = await mountOnChannel(BOT_A);
      const length = harness.history.length;

      await act(async () => {
        await harness.navigate({
          to: "/bot/$botId",
          params: { botId: BOT_A },
          search: { view: "activity" },
        });
      });
      await waitFor(() => {
        expect(harness.history.length).toBe(length + 1);
        expect(urlPlace(harness)).toEqual(placeOf(NOTHING));
      });
      expect(surfaceOf(BOT_A)).toEqual(NOTHING);
      expect(harness.history.location.search).toBe("?view=messages");
    });
  });

  describe("a restart", () => {
    it("puts the stores where the entry the history starts on says", async () => {
      const entry = `/bot/${BOT_A}?view=activity&thread=m-1&threadAnnouncement=true&threadAnchor=answer`;
      const harness = await mount([entry]);

      await waitFor(() => {
        expect(useTracySurfaceStore.getState().botId).toBe(BOT_A);
        expect(surfaceOf(BOT_A)).toEqual({
          ...NOTHING,
          view: "activity",
          rail: T1_ANSWER,
        });
      });
      expect(harness.history.length).toBe(1);
      expect(harness.history.location.href).toBe(entry);
    });

    it("puts a session where the entry says", async () => {
      await mount([
        `/bot/${BOT_A}?view=messages&session=chat-1&sessionThread=t-1`,
      ]);

      await waitFor(() => {
        expect(surfaceOf(BOT_A)).toEqual({
          ...NOTHING,
          session: { chatId: "chat-1", threadId: "t-1" },
        });
      });
    });
  });

  describe("an entry that names Threads and a session", () => {
    it("shows Threads, as it takes the place of a session, and rewrites the entry to say so", async () => {
      const harness = await mount([
        `/bot/${BOT_A}?view=messages&threads=true&session=chat-1`,
      ]);
      const threads = { ...NOTHING, threadsShown: true };

      await waitFor(() => {
        expect(surfaceOf(BOT_A)).toEqual(threads);
        expect(urlPlace(harness)).toEqual(placeOf(threads));
      });
      expect(harness.history.length).toBe(1);
    });
  });

  describe("the surface with no channel", () => {
    it("records Threads on /bot and steps back off it", async () => {
      const harness = await mount(["/bot"]);
      await waitFor(() => {
        expect(urlPlace(harness)).toEqual(placeOf(NOTHING));
      });
      const length = harness.history.length;

      act(() => place().setThreadsShown(true));
      await waitForUrl(
        harness,
        "/bot",
        placeOf({ ...NOTHING, threadsShown: true }),
      );
      expect(harness.history.length).toBe(length + 1);

      stepBack(harness);
      await waitFor(() => {
        expect(place().threadsShown).toBe(false);
      });
      expect(urlPlace(harness)).toEqual(placeOf(NOTHING));
    });
  });

  describe("the arrows, the swipe gestures and the system back", () => {
    it("step through places with goBack and goForward", async () => {
      const harness = await mountOnChannel(BOT_A);
      const activity = { ...NOTHING, view: "activity" } as const;
      act(() => place().setView(BOT_A, "activity"));
      await waitForUrl(harness, `/bot/${BOT_A}`, placeOf(activity));

      act(() => goBack(harness));
      await waitFor(() => {
        expect(surfaceOf(BOT_A)).toEqual(NOTHING);
      });
      expect(urlPlace(harness)).toEqual(placeOf(NOTHING));

      act(() => goForward(harness));
      await waitFor(() => {
        expect(surfaceOf(BOT_A)).toEqual(activity);
      });
      expect(urlPlace(harness)).toEqual(placeOf(activity));
    });
  });

  describe("drafts", () => {
    it("are untouched by any move, Back or Forward", async () => {
      const harness = await mountOnChannel(BOT_A);
      const drafts = useBotDraftsStore.getState();
      drafts.typeThreadBox(BOT_A, "conversation-1", "channel box", null);
      drafts.typeThreadBox(BOT_A, "m-1", "thread box", null);
      drafts.setAnswer(BOT_A, "q-1#0", {
        chosen: ["a"],
        typed: "typed answer",
        skip: false,
        sent: null,
        unsureSince: null,
      });
      drafts.offerUnsent(BOT_A, "m-2", {
        text: "unsent",
        wire: "unsent",
        supersedes: null,
        content: { type: "doc", content: [] },
      });
      const held = () => {
        const { answers, threadBoxes, unsentBoxes } =
          useBotDraftsStore.getState();
        return { answers, threadBoxes, unsentBoxes };
      };
      const before = held();
      const index = indexOf(harness);

      act(() => place().setView(BOT_A, "activity"));
      act(() => rails().setRail(BOT_A, T1));
      act(() => rails().setRail(BOT_A, memoryRailOver(railOf(BOT_A))));
      act(() => place().setSession(BOT_A, CHAT));
      act(() => place().setThreadsShown(true));
      await waitFor(() => {
        expect(indexOf(harness)).toBe(index + 5);
      });
      expect(held()).toEqual(before);

      for (let step = 0; step < 5; step += 1) {
        const target = index + 4 - step;
        stepBack(harness);
        await waitFor(() => {
          expect(indexOf(harness)).toBe(target);
        });
        expect(held()).toEqual(before);
      }
      for (let step = 0; step < 5; step += 1) {
        const target = index + 1 + step;
        stepForward(harness);
        await waitFor(() => {
          expect(indexOf(harness)).toBe(target);
        });
        expect(held()).toEqual(before);
      }
    });
  });

  describe("a bot shown gone", () => {
    const ENTRIES = [
      `/bot/${BOT_A}?view=messages`,
      `/bot/${BOT_B}?view=activity`,
      "/bot/bot-c?view=messages",
    ];
    const WINDOW_ID = "tracy-place-gone-bot";

    /**
     * The branded history the desktop runs, which owns its entry list: the
     * semantic `goBack` is the one that skips entries.
     */
    function branded(): RouterHistory {
      window.localStorage.setItem(
        `traycer-gui-app:last-route:${WINDOW_ID}`,
        JSON.stringify({ entries: ENTRIES, index: 2 }),
      );
      return createPersistentMemoryHistory(null, WINDOW_ID);
    }

    it("is skipped by Back, and taken back by a list that carries it", () => {
      const history = branded();
      act(() => useTracySurfaceStore.getState().forgetBot(BOT_B, 1));

      act(() => goBack({ history }));
      expect(history.location.pathname).toBe(`/bot/${BOT_A}`);

      act(() => goForward({ history }));
      expect(history.location.pathname).toBe("/bot/bot-c");

      act(() =>
        useTracySurfaceStore.getState().settleListedBots(new Set([BOT_B]), 2),
      );
      act(() => goBack({ history }));
      expect(history.location.pathname).toBe(`/bot/${BOT_B}`);
    });

    it("is forgotten when the surface closes", () => {
      const canvas = useEpicCanvasStore.getState();
      act(() => useTracySurfaceStore.getState().forgetBot(BOT_B, 1));
      expect(isHistoryEntryDead(ENTRIES[1])).toBe(true);
      expect(isHistoryEntryEligible(ENTRIES[1], canvas)).toBe(false);

      act(() => useTracySurfaceStore.getState().closeSurface());
      expect(isHistoryEntryDead(ENTRIES[1])).toBe(false);
      expect(isHistoryEntryEligible(ENTRIES[1], canvas)).toBe(true);
    });
  });
});
