import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MobileTileOriginCrumb } from "@/components/epic-canvas/mobile/mobile-tile-header-actions";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import * as TabNav from "@/lib/tab-navigation";
import { openEpicTabIntent } from "@/lib/tab-navigation/intents";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const WINDOW_HOST = "host-window";

/** Every open task tab's crumb, as each task's pane header draws it. */
function Crumbs() {
  const tabIds = useEpicCanvasStore((s) => s.openTabOrder);
  return (
    <>
      {tabIds.map((tabId) => (
        <div key={tabId} data-testid={`crumb-of-${tabId}`}>
          <MobileTileOriginCrumb tabId={tabId} />
        </div>
      ))}
    </>
  );
}

interface Mounted {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: () => string;
}

async function mountApp(): Promise<Mounted> {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <TabNavigationRouteBridge />
        <Crumbs />
        <Outlet />
      </QueryClientProvider>
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
  return {
    navigate: router.navigate,
    pathname: () => router.state.location.pathname,
  };
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

async function showChannel(app: Mounted, botId: string): Promise<void> {
  act(() => {
    useTracySurfaceStore.getState().openSurface("host-A");
    TabNav.navigateToTabIntent(
      app.navigate,
      { kind: "tracy", botId },
      undefined,
    );
  });
  await waitFor(() => {
    expect(useTabsStore.getState().activeItemId).toBe("tab:tracy:tracy");
    expect(useTracySurfaceStore.getState().botId).toBe(botId);
  });
}

/** A task opened from the channel Tracy shows now. */
async function openTaskFromChannel(
  app: Mounted,
  botId: string,
  epicId: string,
): Promise<string> {
  await showChannel(app, botId);
  act(() => {
    TabNav.navigateToTabIntent(
      app.navigate,
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

function crumbOf(tabId: string): HTMLElement | null {
  return within(screen.getByTestId(`crumb-of-${tabId}`)).queryByRole("button", {
    name: "Back to Tracy",
  });
}

describe("<MobileTileOriginCrumb />", () => {
  beforeEach(() => {
    resetStores();
    setPhoneLayoutOnly(true);
  });
  afterEach(() => {
    cleanup();
    setPhoneLayoutOnly(false);
    resetStores();
  });

  it("draws the way back to Tracy for a task opened from a channel", async () => {
    const app = await mountApp();
    const tabId = await openTaskFromChannel(app, "bot-1", "epic-1");
    expect(crumbOf(tabId)).not.toBeNull();
  });

  it("goes back to the channel recorded at open, not the one the surface moved to, and spends the origin", async () => {
    const app = await mountApp();
    const tabId = await openTaskFromChannel(app, "bot-1", "epic-1");
    await showChannel(app, "bot-2");
    const crumb = crumbOf(tabId);
    if (crumb === null) throw new Error("the crumb was not drawn");

    fireEvent.click(crumb);

    await waitFor(() => {
      expect(app.pathname()).toBe("/bot/bot-1");
      expect(useTracySurfaceStore.getState().botId).toBe("bot-1");
    });
    expect(useMobileTabOriginStore.getState().botIdByTabId).not.toHaveProperty(
      tabId,
    );
    expect(crumbOf(tabId)).toBeNull();
  });

  it("goes when its channel's bot is forgotten, and leaves another channel's origin", async () => {
    const app = await mountApp();
    const forgotten = await openTaskFromChannel(app, "bot-1", "epic-1");
    const kept = await openTaskFromChannel(app, "bot-2", "epic-2");
    expect(crumbOf(forgotten)).not.toBeNull();

    act(() => useTracySurfaceStore.getState().forgetBot("bot-1"));

    expect(crumbOf(forgotten)).toBeNull();
    expect(crumbOf(kept)).not.toBeNull();
  });

  it("goes when the surface closes, and does not come back when it reopens", async () => {
    const app = await mountApp();
    const tabId = await openTaskFromChannel(app, "bot-1", "epic-1");
    expect(crumbOf(tabId)).not.toBeNull();

    act(() => useTracySurfaceStore.getState().closeSurface());
    expect(crumbOf(tabId)).toBeNull();

    act(() => useTracySurfaceStore.getState().openSurface("host-A"));
    expect(crumbOf(tabId)).toBeNull();
  });
});
