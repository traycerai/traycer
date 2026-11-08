/**
 * The way back from a task to a Tracy channel exists only for a task a link in
 * that channel's transcript opened, and only for the visit that link started.
 * These cases drive the real navigation controller over a real router history
 * (through the real route bridge), the real tabs, canvas and Tracy surface
 * stores, and read what the origin store kept.
 */
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
} from "@tanstack/react-router";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import * as TabNav from "@/lib/tab-navigation";
import { tabNavigationController } from "@/lib/tab-navigation";
import {
  existingEpicTabIntent,
  fromTracyTranscript,
  openEpicTabIntent,
  type TracyTranscriptOrigin,
} from "@/lib/tab-navigation/intents";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const WINDOW_HOST = "host-window";

async function mountRouter(): Promise<UseNavigateResult<string>> {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TabNavigationRouteBridge />
        <Outlet />
      </>
    ),
  });
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  return router.navigate;
}

function resetStores(): void {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
  useMobileTabOriginStore.setState(
    useMobileTabOriginStore.getInitialState(),
    true,
  );
  useSelectionAuthorityStore.setState({
    attached: true,
    effectiveHostId: WINDOW_HOST,
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  tabCommandCoordinator.resetReconciliationForTesting();
  TabNav.__resetTabNavigationControllerForTesting();
}

/** Tracy in front on `botId`'s channel, the way the channel column opens it. */
async function showChannel(
  navigate: UseNavigateResult<string>,
  botId: string | null,
): Promise<void> {
  act(() => {
    useTracySurfaceStore.getState().openSurface("host-A");
    TabNav.navigateToTabIntent(navigate, { kind: "tracy", botId }, undefined);
  });
  await waitFor(() => {
    expect(useTabsStore.getState().activeItemId).toBe("tab:tracy:tracy");
    expect(useTracySurfaceStore.getState().botId).toBe(botId);
  });
}

const FROM_BOT_1: TracyTranscriptOrigin = { botId: "bot-1" };

function dispatchOpen(
  navigate: UseNavigateResult<string>,
  epicId: string,
  origin: TracyTranscriptOrigin | null,
): void {
  act(() => {
    TabNav.navigateToTabIntent(
      navigate,
      fromTracyTranscript(
        openEpicTabIntent({ epicId, focus: undefined }),
        origin,
      ),
      undefined,
    );
  });
}

/** Opens the task and waits until it is in front with its tab resolved. */
async function openTask(
  navigate: UseNavigateResult<string>,
  epicId: string,
  origin: TracyTranscriptOrigin | null,
): Promise<string> {
  dispatchOpen(navigate, epicId, origin);
  await waitFor(() => {
    const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(epicId);
    expect(tabId).not.toBe(null);
    expect(useTabsStore.getState().activeItemId).toBe(`tab:epic:${tabId}`);
  });
  const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(epicId);
  if (tabId === null) throw new Error("the task did not get a tab");
  return tabId;
}

/**
 * A `navigate` that holds every navigation it is handed until `release`, so a
 * test can change the surface between a click and its acknowledgement.
 */
interface HeldNavigate {
  readonly navigate: UseNavigateResult<string>;
  readonly release: () => Promise<void>;
}

function heldNavigate(real: UseNavigateResult<string>): HeldNavigate {
  const held: Array<() => Promise<void>> = [];
  const navigate: UseNavigateResult<string> = (options) =>
    new Promise<void>((resolve, reject) => {
      held.push(() => real(options).then(resolve, reject));
    });
  return {
    navigate,
    release: async () => {
      for (const run of held.splice(0)) await run();
    },
  };
}

/**
 * Waits until the task's opening has landed: the controller has nothing in
 * flight and the task's tab is still in front, which a refusal would have
 * undone by restoring the tab in front before it.
 */
async function waitForOpeningLanded(epicId: string): Promise<void> {
  await waitFor(() => {
    expect(TabNav.getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(epicId);
    expect(useTabsStore.getState().activeItemId).toBe(`tab:epic:${tabId}`);
  });
}

/** Releases the held navigation and waits for `epicId`'s opening to land. */
async function releaseAndSettle(
  held: HeldNavigate,
  epicId: string,
): Promise<void> {
  await act(async () => {
    await held.release();
  });
  await waitForOpeningLanded(epicId);
}

function origin(): { tabId: string; botId: string } | null {
  return useMobileTabOriginStore.getState().origin;
}

function activateStripTab(
  navigate: UseNavigateResult<string>,
  epicId: string,
  tabId: string,
): void {
  act(() => {
    TabNav.navigateToTabIntent(
      navigate,
      existingEpicTabIntent({ epicId, tabId, focus: undefined }),
      undefined,
    );
  });
}

describe("mobile tab origin", () => {
  beforeEach(() => {
    resetStores();
    setPhoneLayoutOnly(true);
  });
  afterEach(() => {
    cleanup();
    setPhoneLayoutOnly(false);
    resetStores();
  });

  it("lands the bot the link carried, not the channel the surface shows when the open executes", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    act(() => {
      useTracySurfaceStore.setState({ botId: "bot-2" });
    });
    dispatchOpen(navigate, "epic-1", FROM_BOT_1);
    await waitFor(() => expect(origin()).not.toBeNull());
    const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic("epic-1");
    expect(origin()).toEqual({ tabId, botId: "bot-1" });
  });

  it("leaves no way back for an open from Tracy that no transcript link made", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    await openTask(navigate, "epic-1", null);
    expect(origin()).toBeNull();
  });

  it("lands a hydration-queued transcript open on the tab it resolved to with its carried bot", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    TabNav.__resetTabNavigationHydrationForTesting();
    dispatchOpen(navigate, "epic-1", FROM_BOT_1);
    expect(origin()).toBeNull();
    act(() => {
      useTracySurfaceStore.setState({ botId: "bot-2" });
    });

    act(() => tabNavigationController.setHydrationReady(true, navigate));

    await waitFor(() => expect(origin()).not.toBeNull());
    const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic("epic-1");
    expect(origin()).toEqual({ tabId, botId: "bot-1" });
  });

  it("spends the way back when the same task is reopened by a manual open while in front", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    await openTask(navigate, "epic-1", FROM_BOT_1);
    expect(origin()).not.toBeNull();

    dispatchOpen(navigate, "epic-1", null);

    await waitFor(() => expect(origin()).toBeNull());
  });

  it("spends the way back when the strip taps the task that is already in front", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1", FROM_BOT_1);
    expect(origin()).not.toBeNull();

    activateStripTab(navigate, "epic-1", tabId);

    await waitFor(() => expect(origin()).toBeNull());
  });

  it("shows no way back when the strip revisits the task after Tracy took the front", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1", FROM_BOT_1);

    await showChannel(navigate, "bot-1");
    expect(origin()).toBeNull();

    activateStripTab(navigate, "epic-1", tabId);
    await waitFor(() => {
      expect(useTabsStore.getState().activeItemId).toBe(`tab:epic:${tabId}`);
    });
    expect(origin()).toBeNull();
  });

  it("spends the way back when another task tab takes the front", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    await openTask(navigate, "epic-1", FROM_BOT_1);

    await openTask(navigate, "epic-2", null);

    expect(origin()).toBeNull();
  });

  it("spends the way back when the task's tab is closed", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1", FROM_BOT_1);

    act(() => {
      tabCommandCoordinator.closeRef({ kind: "epic", id: tabId });
    });

    expect(origin()).toBeNull();
  });

  it("keeps the way back through in-task focus changes, such as the phone's second tile", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1", FROM_BOT_1);

    act(() => {
      useEpicCanvasStore.getState().setMobileSecondaryTile(tabId, {
        instanceId: "tile-2",
        transient: false,
      });
    });

    expect(origin()).toEqual({ tabId, botId: "bot-1" });
  });

  it("keeps the way back while the task stays focused in a two-pane split, and spends it when the split's other side takes focus", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const other = await openTask(navigate, "epic-2", null);
    const tabId = await openTask(navigate, "epic-1", FROM_BOT_1);
    const left = { kind: "epic", id: tabId } as const;
    const right = { kind: "epic", id: other } as const;

    act(() => {
      tabCommandCoordinator.pairTabs({
        left,
        right,
        splitId: "split-1",
        leftRatio: 0.5,
        focusedRef: left,
      });
    });
    expect(origin()).toEqual({ tabId, botId: "bot-1" });

    act(() => {
      tabCommandCoordinator.focusSplitSide({
        splitId: "split-1",
        side: "right",
      });
    });
    expect(origin()).toBeNull();
  });

  describe("an opening still pending when its bot or surface goes", () => {
    it("lands no way back when the surface closes before the acknowledgement", async () => {
      const real = await mountRouter();
      await showChannel(real, "bot-1");
      const held = heldNavigate(real);
      dispatchOpen(held.navigate, "epic-1", FROM_BOT_1);

      act(() => useTracySurfaceStore.getState().closeSurface());
      await releaseAndSettle(held, "epic-1");

      expect(origin()).toBeNull();
    });

    it("lands no way back when the bot is forgotten before the acknowledgement", async () => {
      const real = await mountRouter();
      await showChannel(real, "bot-1");
      const held = heldNavigate(real);
      dispatchOpen(held.navigate, "epic-1", FROM_BOT_1);

      act(() => useTracySurfaceStore.getState().forgetBot("bot-1"));
      await releaseAndSettle(held, "epic-1");

      expect(origin()).toBeNull();
    });

    it("does not revive a stale opening when the surface reopens on the same bot before the acknowledgement", async () => {
      const real = await mountRouter();
      await showChannel(real, "bot-1");
      const held = heldNavigate(real);
      dispatchOpen(held.navigate, "epic-1", FROM_BOT_1);

      act(() => {
        useTracySurfaceStore.getState().closeSurface();
        useTracySurfaceStore.getState().openSurface("host-A");
        useTracySurfaceStore.getState().selectChannel("bot-1");
      });
      await releaseAndSettle(held, "epic-1");

      expect(origin()).toBeNull();
    });

    it.each([
      [
        "the surface closes",
        () => useTracySurfaceStore.getState().closeSurface(),
      ],
      [
        "the bot is forgotten",
        () => useTracySurfaceStore.getState().forgetBot("bot-1"),
      ],
    ])(
      "lands no way back when %s while the opening is hydration-queued",
      async (_name, invalidate) => {
        const navigate = await mountRouter();
        await showChannel(navigate, "bot-1");
        TabNav.__resetTabNavigationHydrationForTesting();
        dispatchOpen(navigate, "epic-1", FROM_BOT_1);

        act(invalidate);
        act(() => tabNavigationController.setHydrationReady(true, navigate));
        await waitForOpeningLanded("epic-1");

        expect(origin()).toBeNull();
      },
    );

    it("still lands the carried bot when only an unrelated bot is forgotten before the acknowledgement", async () => {
      const real = await mountRouter();
      await showChannel(real, "bot-1");
      const held = heldNavigate(real);
      dispatchOpen(held.navigate, "epic-1", FROM_BOT_1);

      act(() => useTracySurfaceStore.getState().forgetBot("bot-2"));
      await releaseAndSettle(held, "epic-1");

      await waitFor(() => expect(origin()).not.toBeNull());
      const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic("epic-1");
      expect(origin()).toEqual({ tabId, botId: "bot-1" });
    });
  });

  it("records nothing off the installed app", async () => {
    setPhoneLayoutOnly(false);
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    await openTask(navigate, "epic-1", FROM_BOT_1);
    expect(origin()).toBeNull();
  });
});
