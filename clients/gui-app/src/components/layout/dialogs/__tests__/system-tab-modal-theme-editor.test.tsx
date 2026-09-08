import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { ThemeEditorHost } from "@/components/settings/themes/theme-editor-host";
import { ThemeProvider } from "@/providers/theme-provider";
import {
  useSystemTabModalController,
  resetSystemTabModalColdLoadForTests,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => ({
    hosts: [],
    host: null,
    hostId: null,
    hostLabel: "No host",
    vanishedHostId: null,
    returnToActive: () => {},
    activeHostId: null,
    activeHost: null,
    isViewingActive: true,
    status: "unreachable",
    client: null,
    localMaintenanceFallback: false,
    setHostId: () => {},
    makeActive: () => {},
    isActivating: false,
    isLoading: false,
    listsFailed: false,
    retryLists: () => {},
    nowMs: 0,
  }),
}));

const modalProbe: { current: SystemTabModalApi | null } = { current: null };

function ModalProbe() {
  const api = useSystemTabModalController();
  useEffect(() => {
    modalProbe.current = api;
  }, [api]);
  return null;
}

function buildRouter() {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: () => (
      <>
        <ModalProbe />
        <SystemTabModalHost />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="underlay" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function resetStores(): void {
  window.localStorage.clear();
  modalProbe.current = null;
  useSettingsSectionStore.setState({ section: null });
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useSettingsStore.setState({ theme: "light", themePreset: "neutral" });
  useThemeLibraryStore.setState({
    version: 1,
    themes: [],
    selected: { light: null, dark: null },
    glassOpacity: 100,
    draft: null,
    error: null,
  });
}

describe("SystemTabModalHost theme editor integration", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetSystemTabModalColdLoadForTests();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    __resetTabNavigationControllerForTesting();
    resetSystemTabModalColdLoadForTests();
    document.body.style.pointerEvents = "";
    resetStores();
  });

  it("releases and restores the Settings modal lock around theme editing", async () => {
    const user = userEvent.setup();
    const router = buildRouter();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeProvider>
            <RouterProvider router={router} />
            <ThemeEditorHost />
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(modalProbe.current).not.toBeNull());
    modalProbe.current?.openSettings({
      section: "appearance",
      resetToGeneral: false,
    });

    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => {
      expect(document.body.style.pointerEvents).toBe("none");
    });
    await user.click(
      within(settings).getByRole("button", { name: "Create theme" }),
    );

    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe("none");
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(document.activeElement).toBe(
      within(editor).getByLabelText("Theme name"),
    );

    await user.click(
      within(editor).getByRole("button", { name: "Cancel theme editing" }),
    );
    await waitFor(() => {
      expect(useThemeLibraryStore.getState().draft).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Theme editor" })).toBeNull();
      expect(document.body.style.pointerEvents).toBe("none");
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });
});
