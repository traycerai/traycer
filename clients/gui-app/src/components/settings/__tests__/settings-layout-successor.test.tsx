/**
 * Layout's successor, through the REAL hosts.
 *
 * With the Customize editor available, the Layout page's rows live on
 * Appearance. Both presentations of Settings move a reader there through one
 * hook (`useSettingsSectionSuccessor`) that writes the successor into that
 * presentation's own authority - the modal's section store, the tab's route or
 * remembered path. These tests mount the actual `SystemTabModalHost` and the
 * actual `settingsTabModule` surface behind a real router with real stores, and
 * assert the STATE they keep, not just what they draw.
 */
import { useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { ThemeProvider } from "@/providers/theme-provider";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { settingsTabModule } from "@/stores/tabs/kinds/settings";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  resetSystemTabModalColdLoadForTests,
  useSystemTabModalController,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => hostScopeFixture({}),
}));

// The Layout page's provider list reads the watched host's scope; it carries no
// anchors and this suite never asserts it (same boundary the fixture suite and
// the page's own suite mock).
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitResolveHostScope: () => ({
    scope: hostScopeFixture({}),
    hasExplicitPick: false,
  }),
}));

vi.mock("@/components/epics/history-modal-content", () => ({
  HistoryModalContent: () => null,
}));

const modalProbe: { current: SystemTabModalApi | null } = { current: null };

function ModalProbe(): ReactNode {
  const api = useSystemTabModalController();
  useEffect(() => {
    modalProbe.current = api;
  }, [api]);
  return null;
}

function TabHost(): ReactNode {
  const tab = useTabsStore((state) => state.systemTabs.settings);
  if (tab === null) return null;
  // The tab's REAL body: the descriptor's own render, not the surface imported
  // by hand.
  return (
    <Suspense fallback={null}>
      {settingsTabModule.descriptor.surface.render(
        settingsTabModule.build({
          kind: "settings",
          id: "settings",
          name: tab.name,
          lastPath: tab.lastPath,
        }),
      )}
    </Suspense>
  );
}

function buildRouter(initialEntry: string) {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: () => (
      <>
        <ModalProbe />
        <SystemTabModalHost />
        <TabHost />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="underlay" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function mount(initialEntry: string) {
  const router = buildRouter(initialEntry);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

const revealRequests: Array<string | null> = [];
let unsubscribeReveal: (() => void) | null = null;

function resetStores(): void {
  window.localStorage.clear();
  modalProbe.current = null;
  revealRequests.length = 0;
  useSettingsSectionStore.setState({ section: null });
  useSettingsSearchStore.setState({ pendingReveal: null, query: "" });
  useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

beforeEach(() => {
  __resetTabNavigationControllerForTesting();
  resetSystemTabModalColdLoadForTests();
  resetStores();
  setWidth(1280);
  unsubscribeReveal = useSettingsSearchStore.subscribe((state) => {
    if (state.pendingReveal !== null) {
      revealRequests.push(state.pendingReveal.anchor);
    }
  });
});

afterEach(() => {
  unsubscribeReveal?.();
  cleanup();
  __resetTabNavigationControllerForTesting();
  resetSystemTabModalColdLoadForTests();
  document.body.style.pointerEvents = "";
  setWidth(1024);
  resetStores();
});

const CARD_ANCHOR = APPEARANCE.definitions.customizeCard.anchor;

describe("Settings modal, Layout section, editor available", () => {
  async function openModalAt(section: "layout" | "appearance"): Promise<void> {
    await waitFor(() => expect(modalProbe.current).not.toBeNull());
    act(() => {
      modalProbe.current?.openSettings({ section, resetToGeneral: false });
    });
  }

  it("lands on Appearance with the modal's own state saying so, and arms the card reveal", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    mount("/");

    await openModalAt("layout");

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await within(dialog).findByRole("button", { name: "Customize layout" });
    // The state the modal KEEPS - what opener capture and promotion read - is
    // the successor, not Layout behind a substituted render.
    expect(useSettingsSectionStore.getState().section).toBe("appearance");
    expect(modalProbe.current?.active).toEqual({
      kind: "settings",
      section: "appearance",
    });
    expect(revealRequests).toContain(CARD_ANCHOR);
    expect(within(dialog).queryByTestId("layout-presets-group")).toBeNull();
  });

  it("a remembered Layout section is moved the same way when the modal opens", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    useSettingsSectionStore.setState({ section: "layout" });
    mount("/");

    await openModalAt("layout");

    await screen.findByRole("button", { name: "Customize layout" });
    expect(useSettingsSectionStore.getState().section).toBe("appearance");
  });

  it("turning the switch off on the successor leaves the reader on Appearance", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    mount("/");
    await openModalAt("layout");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await within(dialog).findByRole("button", { name: "Customize layout" });
    const heading = within(dialog).getByRole("heading", {
      level: 1,
      name: "Appearance",
    });

    fireEvent.click(
      within(dialog).getByRole("switch", { name: "Visual layout editor" }),
    );

    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: "Customize layout" }),
      ).toBeNull(),
    );
    expect(useSettingsSectionStore.getState().section).toBe("appearance");
    // The same panel, not swapped for Layout and back.
    expect(heading.isConnected).toBe(true);
    expect(within(dialog).queryByTestId("layout-presets-group")).toBeNull();
  });

  it("shows the full Layout page with the switch off, and leaves the section alone", async () => {
    mount("/");

    await openModalAt("layout");

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await within(dialog).findByTestId("layout-presets-group");
    expect(useSettingsSectionStore.getState().section).toBe("layout");
    expect(revealRequests).toEqual([]);
  });

  it("keeps the full Layout page when the window narrows below md with the switch on", async () => {
    // Below md the two-pane modal is never opened fresh (phones go straight to
    // the full-page section), so the case is a modal that is ALREADY open on
    // Layout when the switch goes on and the window is narrow at the same time.
    const listeners = new Set<() => void>();
    const original = window.matchMedia;
    window.matchMedia = (query: string): MediaQueryList => {
      const list = original.call(window, query);
      list.addEventListener = (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ): void => {
        listeners.add(() => {
          if (typeof listener === "function") listener(new Event("change"));
          else listener.handleEvent(new Event("change"));
        });
      };
      return list;
    };
    try {
      mount("/");
      await openModalAt("layout");
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      await within(dialog).findByTestId("layout-presets-group");

      act(() => {
        setWidth(500);
        for (const listener of listeners) listener();
        useSettingsStore.setState({ visualLayoutEditorEnabled: true });
      });

      // Switch on but window narrow: the editor is unavailable, so Layout stays
      // exactly as it was and nothing is moved or revealed.
      expect(within(dialog).getByTestId("layout-presets-group")).toBeTruthy();
      expect(useSettingsSectionStore.getState().section).toBe("layout");
      expect(revealRequests).toEqual([]);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("Settings tab, Layout section, editor available", () => {
  function openSettingsTab(lastPath: string): void {
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath,
    });
  }

  it("replaces /settings/layout with /settings/appearance and reveals the card", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    openSettingsTab("/settings/layout");
    const router = mount("/settings/layout");

    await screen.findByRole("button", { name: "Customize layout" });

    expect(router.state.location.pathname).toBe("/settings/appearance");
    expect(revealRequests).toContain(CARD_ANCHOR);
    // REPLACED: Back has nothing to bounce off.
    expect(router.history.length).toBe(1);
  });

  it("moves a remembered Layout path when a split partner owns the route", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    openSettingsTab("/settings/layout");
    const router = mount("/");

    await screen.findByRole("button", { name: "Customize layout" });

    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/appearance",
    );
    // The route belongs to someone else and is left alone.
    expect(router.state.location.pathname).toBe("/");
    expect(revealRequests).toContain(CARD_ANCHOR);
  });

  it("shows the full Layout page with the switch off, with no move", async () => {
    openSettingsTab("/settings/layout");
    const router = mount("/settings/layout");

    await screen.findByTestId("layout-presets-group");

    expect(router.state.location.pathname).toBe("/settings/layout");
    expect(revealRequests).toEqual([]);
  });

  it("keeps the full Layout page at a narrow window with the switch on", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    setWidth(500);
    openSettingsTab("/settings/layout");
    const router = mount("/settings/layout");

    await screen.findByTestId("layout-presets-group");

    expect(router.state.location.pathname).toBe("/settings/layout");
    expect(revealRequests).toEqual([]);
  });

  it("follows the switch live: turning it on moves a reader who is on Layout", async () => {
    openSettingsTab("/settings/layout");
    const router = mount("/settings/layout");
    await screen.findByTestId("layout-presets-group");

    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    });

    await screen.findByRole("button", { name: "Customize layout" });
    expect(router.state.location.pathname).toBe("/settings/appearance");
  });
});
