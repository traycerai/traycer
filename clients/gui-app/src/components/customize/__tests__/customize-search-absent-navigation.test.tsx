import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomizeSearch } from "@/components/customize/customize-search";
import { getSampleWorkspaceOpener } from "@/lib/customize/enter-exit";
import {
  __resetTabNavigationControllerForTesting,
  tabNavigationController,
} from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  tabItemId,
  tabRefKey,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };
const OPENER = {
  kind: "settings-tab",
  tabId: "settings",
  section: "general",
  scrollTop: 12,
} as const;

// Real router + real tab-navigation controller. Only the route components are
// stubs: the point is what CustomizeSearch does to the router, tab strip,
// canvas store and Customize session, not what the destination renders.
function SearchRoot() {
  return <CustomizeSearch unreachable={new Set()} />;
}

function mountAtHome() {
  const root = createRootRoute({ component: SearchRoot });
  const routes = ["/", "/sample-workspace", "/epics/$epicId/$tabId"].map(
    (path) => createRoute({ getParentRoute: () => root, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Same wiring as TabNavigationRouteBridge, minus hydration.
  tabNavigationController.setNavigator(router.navigate);
  tabNavigationController.setLocationReader(() => ({
    pathname: router.state.location.pathname,
    state: router.state.location.state,
    search: router.state.location.search,
  }));
  const unsubscribe = router.history.subscribe((event) => {
    tabNavigationController.observeLocation(
      {
        pathname: event.location.pathname,
        state: event.location.state,
        search: router.options.parseSearch(event.location.search),
      },
      event.action.type,
      router.navigate,
    );
  });
  render(<RouterProvider router={router} />);
  return { router, unsubscribe };
}

function focusedRefKey(): string | null {
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  return active?.kind === "tab" ? tabRefKey(active.ref) : null;
}

// Home is structural (no strip item), so "on Home" is a null active item. The
// epic tab stays open in the strip and keeps its canvas: a retained chat.
function seedRetainedChat() {
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab("epic-a", "A");
  store.openTileInTab(tabId, {
    id: "chat-a",
    instanceId: "inst-chat-a",
    type: "chat",
    name: "Chat A",
    hostId: "host-1",
  });
  // A later tile takes pane focus so the test can tell the chat was re-focused.
  store.openTileInTab(tabId, {
    id: "spec-a",
    instanceId: "inst-spec-a",
    type: "spec",
    name: "Spec A",
    hostId: "host-1",
  });
  const ref: TabRef = { kind: "epic", id: tabId };
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: null,
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState({ ...layout, stripOrder: flattenLayoutRefs(layout) });
  return { ref, tabId };
}

function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: OPENER, startedAt: 0 },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
  __resetTabSyncCoordinatorForTesting();
  __resetTabNavigationControllerForTesting();
}

async function searchMinimap() {
  const input = await screen.findByRole("combobox", {
    name: "Search layout settings",
  });
  fireEvent.change(input, { target: { value: "minimap" } });
  const option = screen.getByRole("option", { name: /minimap/i });
  return { input, option };
}

beforeEach(async () => {
  resetStores();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
});
afterEach(() => {
  cleanup();
  resetStores();
});

describe("CustomizeSearch absent-setting navigation", () => {
  it("Home with no chat: Enter on the absent minimap setting opens the sample workspace", async () => {
    const { router, unsubscribe } = mountAtHome();
    const { input, option } = await searchMinimap();
    expect(option.textContent).toContain("Open sample workspace");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/sample-workspace"),
    );
    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    expect(
      useTabsStore
        .getState()
        .items.filter(
          (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
        ),
    ).toHaveLength(1);
    expect(useTabsStore.getState().systemTabs.settings).toBeNull();
    // Customize left the session, and the sample tab kept the opener for Done.
    expect(useCustomizeStore.getState().session).toBeNull();
    expect(getSampleWorkspaceOpener()).toEqual(OPENER);
    unsubscribe();
  });

  it("Home with a retained chat: Enter on the absent minimap setting focuses that chat tile", async () => {
    const { ref, tabId } = seedRetainedChat();
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const chat = Object.values(canvas?.tilesByInstanceId ?? {}).find(
      (tile) => tile?.type === "chat",
    );
    if (chat === undefined) throw new Error("expected a chat tile");
    expect(canvas?.activePaneId).not.toBeNull();

    const { router, unsubscribe } = mountAtHome();
    const { input, option } = await searchMinimap();
    expect(option.textContent).toContain("Open chat");
    expect(option.textContent).not.toContain("Open sample workspace");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/epics/epic-a/${tabId}`),
    );
    expect(focusedRefKey()).toBe(tabRefKey(ref));
    expect(router.state.location.search).toMatchObject({
      focusTileInstanceId: chat.instanceId,
    });
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
        ),
    ).toBe(false);
    expect(useCustomizeStore.getState().session).toBeNull();
    unsubscribe();
  });

  it("clicking the absent result navigates the same way as Enter", async () => {
    const { router, unsubscribe } = mountAtHome();
    const { option } = await searchMinimap();

    fireEvent.click(option);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/sample-workspace"),
    );
    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    unsubscribe();
  });
});
