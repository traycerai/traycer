import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type Router,
  type RouterHistory,
} from "@tanstack/react-router";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import {
  normalizeTracyPlaceSearch,
  tracyPlaceOfSearch,
  tracyPlaceRailOf,
  type TracyPlace,
} from "@/lib/bots/tracy-place";
import { observeTracyPlaceTraversals } from "@/lib/bots/tracy-place-traversal";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import {
  createPersistentMemoryHistory,
  getHistoryController,
} from "@/lib/persistent-history";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  TracyChannelPlaceRoute,
  TracySurfacePlaceRoute,
} from "@/routes/tracy-route-components";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  useBotOpenThreadStore,
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
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import * as DesktopTabsPersistence from "@/stores/tabs/desktop-tabs-persistence";

/**
 * The Tracy surface's place on the route over the PERSISTED history stack the
 * desktop and the phone run (`createPersistentMemoryHistory`), driven by the
 * real `goBack` / `goForward` commands. The route components are the real
 * `TracyChannelPlaceRoute` / `TracySurfacePlaceRoute`, with the real
 * `normalizeTracyPlaceSearch` as each route's `validateSearch`, under the
 * real `TabNavigationRouteBridge`.
 */

const WINDOW_HOST = "host-window";
const WINDOW_KEY = "tracy-place-persisted";
const STORAGE_KEY = `traycer-gui-app:last-route:${WINDOW_KEY}`;
const BOT_A = "bot-a";

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
const routeTree = rootRoute.addChildren([indexRoute, tracyRoute, channelRoute]);

type TestRouter = Router<typeof routeTree>;

function buildRouter(history: RouterHistory): TestRouter {
  return createRouter({ routeTree, history });
}

interface Harness {
  readonly router: TestRouter;
  readonly stop: () => void;
}

let current: Harness | null = null;

/**
 * Mounts a router over a persistent history keyed `WINDOW_KEY`, seeded from
 * whatever stack that key already holds. The traversal observer is installed
 * on `router.history` before `RouterProvider` mounts, as `createAppRouter`
 * does.
 */
async function mount(initialRoute: string | null): Promise<Harness> {
  const router = buildRouter(
    createPersistentMemoryHistory(initialRoute, WINDOW_KEY),
  );
  const stopObserving = observeTracyPlaceTraversals(router.history);
  const view = render(<RouterProvider router={router} />);
  const harness: Harness = {
    router,
    stop: () => {
      stopObserving();
      view.unmount();
    },
  };
  current = harness;
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  return harness;
}

/**
 * `mount`, with the window's bridge hydrating only when `hydrate` is called,
 * as the desktop's does once the per-window snapshot is applied: the route
 * mounts and puts its place back first, the bridge's restore comes after.
 */
async function mountHydratingLater(): Promise<{
  readonly harness: Harness;
  readonly hydrate: () => void;
}> {
  const router = buildRouter(createPersistentMemoryHistory(null, WINDOW_KEY));
  const stopObserving = observeTracyPlaceTraversals(router.history);
  const tree = (hasHydrated: boolean) => (
    <WindowsBridgeContext.Provider value={{ bridge: null, hasHydrated }}>
      <RouterProvider router={router} />
    </WindowsBridgeContext.Provider>
  );
  const view = render(tree(false));
  const harness: Harness = {
    router,
    stop: () => {
      stopObserving();
      view.unmount();
    },
  };
  current = harness;
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  return { harness, hydrate: () => view.rerender(tree(true)) };
}

function resetStores(): void {
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

function railOf(botId: string): BotRail | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  return Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
}

/** The place the surface's stores hold for `botId`. */
function storePlace(botId: string): TracyPlace {
  const place = useTracyPlaceStore.getState();
  return {
    view: tracyViewOf(place.viewByBotId, botId),
    threadsShown: place.threadsShown,
    session: tracySessionOf(place.sessionByBotId, botId),
    ...tracyPlaceRailOf(railOf(botId)),
  };
}

function urlPlace(harness: Harness): TracyPlace | null {
  return tracyPlaceOfSearch(harness.router.state.location.search);
}

interface Stack {
  readonly index: number;
  readonly entries: ReadonlyArray<string>;
}

/** The stack the history holds, read through its controller. */
function liveStack(harness: Harness): Stack {
  const controller = getHistoryController(harness.router.history);
  if (controller === null) throw new Error("history carries no controller");
  return { index: controller.getIndex(), entries: controller.getEntries() };
}

/** The stack as it sits in storage, which is what a restart reads. */
function storedStack(): Stack {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) throw new Error("nothing persisted");
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.index !== "number" ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("persisted stack has an unexpected shape");
  }
  const entries = parsed.entries.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return { index: parsed.index, entries };
}

function describeStack(stack: Stack): string {
  return `index=${String(stack.index)} entries=${JSON.stringify(stack.entries)}`;
}

async function openChannel(harness: Harness, botId: string): Promise<void> {
  act(() => {
    openBotChannel(harness.router.navigate, botId, {
      landing: null,
      isConnectable: null,
      onRejected: null,
    });
  });
  await waitFor(() => {
    expect(harness.router.state.location.pathname).toBe(`/bot/${botId}`);
    expect(urlPlace(harness)).toEqual(storePlace(botId));
  });
  expect(useTracySurfaceStore.getState().botId).toBe(botId);
}

async function mountOnChannel(botId: string): Promise<Harness> {
  const harness = await mount("/");
  await openChannel(harness, botId);
  return harness;
}

/** Waits for the route and the stores to say the same place, idle. */
async function settle(harness: Harness, botId: string): Promise<void> {
  await waitFor(() => {
    expect(harness.router.state.status).toBe("idle");
    expect(urlPlace(harness)).toEqual(storePlace(botId));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const place = useTracyPlaceStore.getState;
const rails = useBotOpenThreadStore.getState;

const THREAD_A: BotRail = {
  kind: "thread",
  anchorMessageId: "msg-1",
  announcement: false,
  anchorKind: null,
  sent: null,
};
const MEMORY: BotRail = { kind: "memory", back: null };
const THREAD_B: BotRail = {
  kind: "thread",
  anchorMessageId: "msg-2",
  announcement: false,
  anchorKind: null,
  sent: null,
};

describe("the Tracy surface's place over the persisted history", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetStores();
  });
  afterEach(() => {
    current?.stop();
    current = null;
    cleanup();
    vi.restoreAllMocks();
    resetStores();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  describe("a move by hand, Back, Forward through the real commands", () => {
    it("opening a thread pushes an entry naming it; Back closes it and Forward reopens it", async () => {
      const harness = await mountOnChannel(BOT_A);
      const before = liveStack(harness);

      act(() => rails().setRail(BOT_A, THREAD_A));
      await settle(harness, BOT_A);

      const moved = liveStack(harness);
      expect(moved.entries).toHaveLength(before.entries.length + 1);
      expect(moved.index).toBe(before.index + 1);
      expect(moved.entries.slice(0, before.entries.length)).toEqual(
        before.entries,
      );
      expect(harness.router.state.location.search).toMatchObject({
        view: "messages",
        thread: "msg-1",
      });
      expect(storedStack()).toEqual(moved);

      act(() => goBack(harness.router));
      await waitFor(() => {
        expect(railOf(BOT_A)).toBeNull();
      });
      await settle(harness, BOT_A);
      expect(liveStack(harness).index).toBe(before.index);
      expect(harness.router.state.location.search).not.toHaveProperty("thread");
      expect(liveStack(harness).entries).toEqual(moved.entries);

      act(() => goForward(harness.router));
      await waitFor(() => {
        expect(railOf(BOT_A)).toMatchObject({
          kind: "thread",
          anchorMessageId: "msg-1",
        });
      });
      await settle(harness, BOT_A);
      expect(liveStack(harness)).toEqual(moved);
      expect(harness.router.state.location.search).toMatchObject({
        thread: "msg-1",
      });
    });

    it("switching Messages to Activity pushes an entry; Back and Forward restore the view", async () => {
      const harness = await mountOnChannel(BOT_A);
      const before = liveStack(harness);

      act(() => place().setView(BOT_A, "activity"));
      await settle(harness, BOT_A);

      const moved = liveStack(harness);
      expect(moved.entries).toHaveLength(before.entries.length + 1);
      expect(moved.index).toBe(before.index + 1);
      expect(harness.router.state.location.search).toMatchObject({
        view: "activity",
      });
      expect(storedStack()).toEqual(moved);

      act(() => goBack(harness.router));
      await waitFor(() => {
        expect(storePlace(BOT_A).view).toBe("messages");
      });
      await settle(harness, BOT_A);
      expect(liveStack(harness).index).toBe(before.index);
      expect(harness.router.state.location.search).toMatchObject({
        view: "messages",
      });

      act(() => goForward(harness.router));
      await waitFor(() => {
        expect(storePlace(BOT_A).view).toBe("activity");
      });
      await settle(harness, BOT_A);
      expect(liveStack(harness)).toEqual(moved);
    });
  });

  describe("a restart", () => {
    it("lands on the entry last shown with its place, and Back still steps to the earlier place", async () => {
      const first = await mountOnChannel(BOT_A);
      act(() => rails().setRail(BOT_A, THREAD_A));
      await settle(first, BOT_A);
      act(() => place().setView(BOT_A, "activity"));
      await settle(first, BOT_A);
      const persisted = storedStack();
      const shown = first.router.state.location.href;
      expect(persisted.index).toBe(persisted.entries.length - 1);
      expect(persisted.entries[persisted.index]).toBe(shown);

      // The process ends: the router goes, and the surface's stores start
      // from nothing. The window's tab controller, not the place hook, opens
      // the surface on the channel the persisted entry names, so the surface
      // store is set as it would restore it (persisted open/host/bot).
      first.stop();
      current = null;
      resetStores();
      useTracySurfaceStore.setState({
        open: true,
        hostId: WINDOW_HOST,
        botId: BOT_A,
      });
      expect(storePlace(BOT_A)).toEqual(
        tracyPlaceOfSearch({ view: "messages" }),
      );

      const second = await mount(null);
      expect(storedStack()).toEqual(persisted);
      await waitFor(() => {
        expect(storePlace(BOT_A)).toEqual(urlPlace(second));
      });
      await settle(second, BOT_A);

      expect(second.router.state.location.href).toBe(shown);
      expect(second.router.state.location.search).toMatchObject({
        view: "activity",
        thread: "msg-1",
      });
      expect(storePlace(BOT_A).view).toBe("activity");
      expect(railOf(BOT_A)).toMatchObject({
        kind: "thread",
        anchorMessageId: "msg-1",
      });
      expect(liveStack(second)).toEqual(persisted);

      act(() => goBack(second.router));
      await waitFor(() => {
        expect(storePlace(BOT_A).view).toBe("messages");
      });
      await settle(second, BOT_A);
      expect(liveStack(second).index).toBe(persisted.index - 1);
      expect(railOf(BOT_A)).toMatchObject({
        kind: "thread",
        anchorMessageId: "msg-1",
      });
      expect(second.router.state.location.href).toBe(
        persisted.entries[persisted.index - 1],
      );
    });
  });

  describe("a desktop restart, through the bridge's restore of the route", () => {
    /**
     * The window starts on the persisted entry and the bridge, once hydrated,
     * replaces it with the route the window showed at shutdown - the same
     * href under a new entry key. The restored route is spent once, as the
     * real `consumeDesktopRestoredRoute` does.
     */
    function seedRestoredRoute(route: string): void {
      let pending: string | null = route;
      vi.spyOn(
        DesktopTabsPersistence,
        "consumeDesktopRestoredRoute",
      ).mockImplementation(() => {
        const value = pending;
        pending = null;
        return value;
      });
    }

    const PLACES: ReadonlyArray<
      readonly [string, () => void, (search: Record<string, unknown>) => void]
    > = [
      [
        "Activity with the bot's memory open",
        () => {
          place().setView(BOT_A, "activity");
          rails().setRail(BOT_A, MEMORY);
        },
        (search) => {
          expect(search).toMatchObject({ view: "activity", memory: true });
          expect(storePlace(BOT_A).view).toBe("activity");
          expect(railOf(BOT_A)).toMatchObject({ kind: "memory" });
        },
      ],
      [
        "a thread open beside Messages",
        () => {
          rails().setRail(BOT_A, THREAD_A);
        },
        (search) => {
          expect(search).toMatchObject({ view: "messages", thread: "msg-1" });
          expect(storePlace(BOT_A).view).toBe("messages");
          expect(railOf(BOT_A)).toMatchObject({
            kind: "thread",
            anchorMessageId: "msg-1",
          });
        },
      ],
    ];

    /**
     * Restarts with the stores empty and the surface open on the bot, the
     * bridge restoring `shown`, and checks the entry kept its place.
     * `bridgeFirst`: the bridge is hydrated when the router mounts, so its
     * replace of the entry comes before the route has read it.
     */
    async function restartAndRestore(
      arrange: () => void,
      expectPlace: (search: Record<string, unknown>) => void,
      bridgeFirst: boolean,
    ): Promise<void> {
      const first = await mountOnChannel(BOT_A);
      act(arrange);
      await settle(first, BOT_A);
      const persisted = storedStack();
      const shown = first.router.state.location.href;
      expect(persisted.entries[persisted.index]).toBe(shown);
      expect(persisted.index).toBeGreaterThan(0);

      first.stop();
      current = null;
      resetStores();
      useTracySurfaceStore.setState({
        open: true,
        hostId: WINDOW_HOST,
        botId: BOT_A,
      });
      seedRestoredRoute(shown);
      const consumed = vi.mocked(
        DesktopTabsPersistence.consumeDesktopRestoredRoute,
      );

      let second: Harness;
      if (bridgeFirst) {
        second = await mount(null);
      } else {
        const later = await mountHydratingLater();
        second = later.harness;
        await waitFor(() => {
          expect(storePlace(BOT_A)).toEqual(urlPlace(second));
        });
        expect(consumed).not.toHaveBeenCalled();
        act(later.hydrate);
      }
      await waitFor(() => {
        expect(consumed).toHaveBeenCalled();
        expect(storePlace(BOT_A)).toEqual(urlPlace(second));
      });
      await settle(second, BOT_A);

      expect(second.router.state.location.href).toBe(shown);
      expectPlace(second.router.state.location.search);
      expect(storedStack()).toEqual(persisted);
      expect(storedStack().entries[persisted.index]).toBe(shown);
      expect(liveStack(second)).toEqual(persisted);

      act(() => goBack(second.router));
      await settle(second, BOT_A);
      expect(liveStack(second).index).toBe(persisted.index - 1);
      expect(second.router.state.location.href).toBe(
        persisted.entries[persisted.index - 1],
      );
    }

    it.each(PLACES)(
      "keeps %s when the bridge restores the route before the route has read the entry",
      (_name, arrange, expectPlace) =>
        restartAndRestore(arrange, expectPlace, true),
    );

    it.each(PLACES)(
      "keeps %s when the bridge restores the route after the route has read the entry",
      (_name, arrange, expectPlace) =>
        restartAndRestore(arrange, expectPlace, false),
    );
  });

  describe("two moves in quick succession", () => {
    /**
     * A person gets one entry per move, and Back returns through the place
     * between them: `start` is the entry the moves began on.
     */
    async function expectOneEntryPerMove(
      harness: Harness,
      start: Stack,
      between: () => void,
    ): Promise<void> {
      const stack = liveStack(harness);
      const detail = describeStack(stack);
      expect(stack.entries.length, detail).toBe(start.entries.length + 2);
      expect(stack.index, detail).toBe(start.index + 2);

      act(() => goBack(harness.router));
      await settle(harness, BOT_A);
      expect(liveStack(harness).index, detail).toBe(start.index + 1);
      between();

      act(() => goBack(harness.router));
      await settle(harness, BOT_A);
      expect(liveStack(harness).index, detail).toBe(start.index);
      expect(urlPlace(harness)).toEqual(storePlace(BOT_A));
    }

    it("a thread, then Activity, in two acts without settling between them", async () => {
      const harness = await mountOnChannel(BOT_A);
      const start = liveStack(harness);
      const startPlace = storePlace(BOT_A);

      act(() => rails().setRail(BOT_A, THREAD_A));
      act(() => place().setView(BOT_A, "activity"));
      await settle(harness, BOT_A);

      await expectOneEntryPerMove(harness, start, () => {
        expect(storePlace(BOT_A).view).toBe("messages");
        expect(railOf(BOT_A)).toMatchObject({ anchorMessageId: "msg-1" });
      });
      expect(storePlace(BOT_A)).toEqual(startPlace);
    });

    it("thread A, then thread B, in two acts without settling between them", async () => {
      const harness = await mountOnChannel(BOT_A);
      const start = liveStack(harness);
      const startPlace = storePlace(BOT_A);

      act(() => rails().setRail(BOT_A, THREAD_A));
      act(() => rails().setRail(BOT_A, THREAD_B));
      await settle(harness, BOT_A);

      await expectOneEntryPerMove(harness, start, () => {
        expect(railOf(BOT_A)).toMatchObject({ anchorMessageId: "msg-1" });
      });
      expect(storePlace(BOT_A)).toEqual(startPlace);
    });

    it("a thread and Activity inside one synchronous act are one move: one entry", async () => {
      const harness = await mountOnChannel(BOT_A);
      const start = liveStack(harness);
      const startPlace = storePlace(BOT_A);

      act(() => {
        rails().setRail(BOT_A, THREAD_A);
        place().setView(BOT_A, "activity");
      });
      await settle(harness, BOT_A);
      const stack = liveStack(harness);

      expect(stack.entries.length, describeStack(stack)).toBe(
        start.entries.length + 1,
      );
      expect(stack.index, describeStack(stack)).toBe(start.index + 1);

      act(() => goBack(harness.router));
      await settle(harness, BOT_A);
      expect(liveStack(harness).index).toBe(start.index);
      expect(storePlace(BOT_A)).toEqual(startPlace);
    });
  });
});
