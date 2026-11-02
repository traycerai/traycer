/**
 * The way back from a task to the Tracy channel it was opened from is recorded
 * where every task opening passes: the navigation controller. These cases drive
 * that real controller over a real router history (through the real route bridge)
 * and the real Tracy surface store, and read what the origin store kept.
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
import {
  existingEpicTabIntent,
  homeTabIntent,
  openEpicTabIntent,
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
  useMobileTabOriginStore.setState({ botIdByTabId: {} });
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

async function openTask(
  navigate: UseNavigateResult<string>,
  epicId: string,
): Promise<string> {
  act(() => {
    TabNav.navigateToTabIntent(
      navigate,
      openEpicTabIntent({ epicId, focus: undefined }),
      undefined,
    );
  });
  await waitFor(() => {
    expect(useEpicCanvasStore.getState().resolveTabIdForEpic(epicId)).not.toBe(
      null,
    );
  });
  const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(epicId);
  if (tabId === null) throw new Error("the task did not get a tab");
  return tabId;
}

function origins(): Readonly<Record<string, string>> {
  return useMobileTabOriginStore.getState().botIdByTabId;
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

  it("records the channel Tracy shows at the moment a task is opened from it", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1");
    expect(origins()).toEqual({ [tabId]: "bot-1" });
  });

  it("records nothing when Tracy is in front with no channel selected", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, null);
    await openTask(navigate, "epic-1");
    expect(origins()).toEqual({});
  });

  it("clears the origin when the task is opened from anywhere else", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1");
    act(() => {
      TabNav.navigateToTabIntent(navigate, homeTabIntent(), undefined);
    });
    await waitFor(() => {
      expect(useTabsStore.getState().activeItemId).not.toBe("tab:tracy:tracy");
    });
    await openTask(navigate, "epic-1");
    expect(origins()).not.toHaveProperty(tabId);
  });

  it("leaves the origin alone when the strip activates the task's tab", async () => {
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    const tabId = await openTask(navigate, "epic-1");
    await showChannel(navigate, "bot-1");
    act(() => {
      TabNav.navigateToTabIntent(
        navigate,
        existingEpicTabIntent({ epicId: "epic-1", tabId, focus: undefined }),
        undefined,
      );
    });
    await waitFor(() => {
      expect(useTabsStore.getState().activeItemId).not.toBe("tab:tracy:tracy");
    });
    expect(origins()).toEqual({ [tabId]: "bot-1" });
  });

  it("records nothing off the installed app", async () => {
    setPhoneLayoutOnly(false);
    const navigate = await mountRouter();
    await showChannel(navigate, "bot-1");
    await openTask(navigate, "epic-1");
    expect(origins()).toEqual({});
  });
});
