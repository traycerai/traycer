/**
 * The setup guide's progress, through the production retention boundary.
 *
 * A Settings tab stays MOUNTED behind the tab the reader is on. This used to
 * also cover a step whose target section reassigned itself while nobody was
 * looking - the Customize editor switch, and a narrow window forcing the
 * legacy Layout page regardless of it, could each move the density step
 * between Appearance and Layout without any click. Both mechanisms are gone:
 * a step's section is now fixed data (`setup-guides.ts`), and
 * `SettingsSetupGuide` navigates only from its own Continue/Back handlers, so
 * there is no longer a way for a hidden tab's guide to need to "catch up" on
 * its own. What remains worth proving is the retention boundary itself: a
 * hidden Settings tab keeps its guide progress intact, and shows the guide
 * again, on the correct section, once it is visible.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { useSystemTabModalController } from "@/stores/tabs/use-system-tab-modal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { ThemeProvider } from "@/providers/theme-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { resetSystemTabModalColdLoadForTests } from "@/stores/tabs/use-system-tab-modal";
import { useTabsStore } from "@/stores/tabs/store";

vi.mock("@/components/epics/history-modal-content", () => ({
  HistoryModalContent: () => null,
}));
vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));
vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => hostScopeFixture({}),
  useHostScopeFor: () => hostScopeFixture({}),
}));
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
vi.mock("@/components/epic-tabs/epic-surface", () => ({
  EpicSurface: (props: { readonly tabId: string }) => (
    <div data-testid={`epic-surface-content-${props.tabId}`} />
  ),
}));
vi.mock("@/components/epics/history-surface", () => ({
  HistorySurface: () => null,
}));
vi.mock("@/components/onboarding/onboarding-coachmark", () => ({
  OnboardingCoachmark: () => <div data-testid="guide-coachmark" />,
}));

const SETTINGS_ID = "tab:settings:settings";
const TASK_ID = "tab:epic:epic-a";

// Publishes the modal bridge `navigateToSettingsSection` reads, the way the
// app shell does.
function ModalBridge(): null {
  useSystemTabModalController();
  return null;
}

function buildRouter(initialEntry: string) {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: () => (
      <>
        <ModalBridge />
        <SystemTabModalHost />
        <TopLevelTabHost />
        <Outlet />
      </>
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
  });
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
  });
  return createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, anyRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function seed(): void {
  useEpicCanvasStore
    .getState()
    .openEpicTabWithId("epic-a", "epic-a", "Epic epic-a");
  useTabsStore.setState((state) => ({
    ...state,
    systemTabs: {
      history: null,
      settings: {
        id: "settings",
        kind: "settings",
        name: "Settings",
        lastPath: "/settings/layout",
      },
    },
    items: [
      {
        kind: "tab" as const,
        id: TASK_ID,
        ref: { kind: "epic" as const, id: "epic-a" },
      },
      {
        kind: "tab" as const,
        id: SETTINGS_ID,
        ref: { kind: "settings" as const, id: "settings" },
      },
    ],
    activeItemId: SETTINGS_ID,
    stripOrder: [
      { kind: "epic" as const, id: "epic-a" },
      { kind: "settings" as const, id: "settings" },
    ],
  }));
}

function renderApp(router: AnyRouter): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function reset(): void {
  window.localStorage.clear();
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSettingsSearchStore.setState({ pendingReveal: null, query: "" });
  useOnboardingStore.setState({
    setupProgress: { agents: -1, appearance: 2, cookies: -1 },
    activeSetup: null,
  });
}

// The Settings surface and the coachmark are lazy chunks; loading them once up
// front keeps the assertions below off the transform clock.
beforeAll(async () => {
  await Promise.all([
    import("@/components/settings/settings-surface"),
    import("@/components/onboarding/onboarding-coachmark"),
  ]);
});

beforeEach(() => {
  __resetTabNavigationControllerForTesting();
  resetSystemTabModalColdLoadForTests();
  reset();
});

afterEach(() => {
  cleanup();
  __resetTabNavigationControllerForTesting();
  reset();
});

function settingsSurface(): HTMLElement {
  return screen.getByTestId("top-level-surface-settings-settings");
}

describe("Setup guide across a hidden Settings tab", () => {
  it("keeps its progress hidden behind another tab, and shows the guide again on the same section once Settings returns", async () => {
    seed();
    // Step 3 (the density step) lives on Layout, and `seed()` already backs
    // Settings by "/settings/layout" - there is no longer a section flip to
    // survive, only the hide/show cycle itself.
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 3 } });
    const router = buildRouter("/settings/layout");
    renderApp(router);
    await waitFor(
      () =>
        expect(
          settingsSurface().querySelector("[data-testid='guide-coachmark']"),
        ).not.toBeNull(),
      { timeout: 15_000 },
    );

    // The reader goes to a task tab; the Settings surface stays mounted.
    await act(async () => {
      useTabsStore.setState({ activeItemId: TASK_ID });
      await router.navigate({ to: "/home" });
    });
    expect(settingsSurface().dataset.visible).toBe("false");
    // Progress is the guide's, and untouched while hidden.
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });

    // Back to Settings, on the same section: the guide is shown again.
    await act(async () => {
      useTabsStore.setState({ activeItemId: SETTINGS_ID });
      await router.navigate({ to: "/settings/layout" });
    });

    expect(useTabsStore.getState().activeItemId).toBe(SETTINGS_ID);
    await waitFor(() =>
      expect(
        settingsSurface().querySelector("[data-testid='guide-coachmark']"),
      ).not.toBeNull(),
    );
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
  });
});
