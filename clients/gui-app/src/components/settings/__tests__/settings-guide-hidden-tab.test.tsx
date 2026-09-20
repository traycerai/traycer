/**
 * The setup guide's follow-the-step effect, through the production retention
 * boundary.
 *
 * A Settings tab stays MOUNTED behind the tab the reader is on, so its guide
 * still sees availability flip while nobody is looking at it. Following the
 * step then would call `navigateToSettingsSection`, which re-activates Settings
 * and steals the route from the task. These tests mount the real
 * `TopLevelTabHost` with a real Settings surface and a task tab - stacked, and
 * side by side in a split.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { useSettingsStore } from "@/stores/settings/settings-store";
import { resetSystemTabModalColdLoadForTests } from "@/stores/tabs/use-system-tab-modal";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

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

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

// The viewport hook listens to the media query, so the test owns that listener
// and fires it the way the browser does on a resize.
const mediaListeners = new Set<() => void>();
let originalMatchMedia: typeof window.matchMedia | null = null;

function installMatchMedia(): void {
  originalMatchMedia = window.matchMedia;
  const original = window.matchMedia;
  window.matchMedia = (query: string): MediaQueryList => {
    const list = original.call(window, query);
    list.addEventListener = (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ): void => {
      mediaListeners.add(() => {
        if (typeof listener === "function") listener(new Event("change"));
        else listener.handleEvent(new Event("change"));
      });
    };
    return list;
  };
}

function narrowWindow(): void {
  act(() => {
    setViewportWidth(500);
    for (const listener of mediaListeners) listener();
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
        lastPath: "/settings/appearance",
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

// A split of the task or an EMPTY slot beside Settings (on the right). Focus
// and route-backing are independent on purpose: focusing an empty slot leaves
// route-backing on the populated side, which is the state under test.
function seedSplit(shape: {
  readonly partner: "task" | "empty";
  readonly focusedSide: "left" | "right";
  readonly routeBackingSide: "left" | "right";
}): void {
  seed();
  useTabsStore.setState({
    items: [
      {
        kind: "split",
        id: "pair",
        left:
          shape.partner === "task"
            ? { kind: "tab", ref: { kind: "epic", id: "epic-a" } }
            : { kind: "empty" },
        right: { kind: "tab", ref: { kind: "settings", id: "settings" } },
        focusedSide: shape.focusedSide,
        routeBackingSide: shape.routeBackingSide,
        leftRatio: 0.5,
      },
    ],
    activeItemId: "pair",
    // The flat projection the coordinator checks the layout against: an empty
    // slot contributes no ref.
    stripOrder:
      shape.partner === "task"
        ? [
            { kind: "epic" as const, id: "epic-a" },
            { kind: "settings" as const, id: "settings" },
          ]
        : [{ kind: "settings" as const, id: "settings" }],
  });
}

function splitState() {
  const item = useTabsStore
    .getState()
    .items.find((candidate) => candidate.id === "pair");
  if (item?.kind !== "split") throw new Error("split item missing");
  return {
    focusedSide: item.focusedSide,
    routeBackingSide: item.routeBackingSide,
  };
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
  useSettingsStore.setState({ visualLayoutEditorEnabled: false });
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
  mediaListeners.clear();
  setViewportWidth(1280);
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  if (originalMatchMedia !== null) window.matchMedia = originalMatchMedia;
  __resetTabNavigationControllerForTesting();
  setViewportWidth(1024);
  reset();
});

function settingsSurface(): HTMLElement {
  return screen.getByTestId("top-level-surface-settings-settings");
}

describe("Setup guide across a hidden Settings tab", () => {
  it("does not steal the route when the window narrows behind another tab, and lands on the right section when Settings returns", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    seed();
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 3 } });
    const router = buildRouter("/settings/appearance");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ThemeProvider>
            <RouterProvider router={router} />
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    // Density step, shown on Appearance where its in-place twin points.
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

    narrowWindow();

    // Nothing was pulled: the task is still the active tab on its own route.
    expect(useTabsStore.getState().activeItemId).toBe(TASK_ID);
    expect(router.state.location.pathname).toBe("/home");
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/appearance",
    );
    // Progress is the guide's, and untouched.
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });

    // Back to Settings: the flip that happened while it was hidden is followed
    // now, and the guide is shown on the section its step lives in.
    await act(async () => {
      useTabsStore.setState({ activeItemId: SETTINGS_ID });
      await router.navigate({ to: "/settings/appearance" });
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/layout"),
    );
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

describe("Setup guide in a task + Settings split", () => {
  async function waitForGuideOnAppearance(): Promise<void> {
    await waitFor(
      () =>
        expect(
          settingsSurface().querySelector("[data-testid='guide-coachmark']"),
        ).not.toBeNull(),
      { timeout: 15_000 },
    );
  }

  it("moves only what Settings shows, and takes no focus, when the task side is focused", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    seedSplit({
      partner: "task",
      focusedSide: "left",
      routeBackingSide: "left",
    });
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 3 } });
    const router = buildRouter("/home");
    renderApp(router);
    await waitForGuideOnAppearance();
    // Both panes are on screen; only the task owns focus and the route.
    expect(settingsSurface().dataset.visible).toBe("true");
    expect(settingsSurface().dataset.focused).toBe("false");
    const before = splitState();

    narrowWindow();

    // Settings' own pane now shows Layout, with the guide on it.
    await waitFor(() =>
      expect(
        settingsSurface().querySelector("[data-testid='layout-presets-group']"),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        settingsSurface().querySelector("[data-testid='guide-coachmark']"),
      ).not.toBeNull(),
    );
    // Nothing was taken from the partner.
    expect(splitState()).toEqual(before);
    expect(before).toEqual({ focusedSide: "left", routeBackingSide: "left" });
    expect(router.state.location.pathname).toBe("/home");
    expect(useTabsStore.getState().activeItemId).toBe("pair");
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/layout",
    );
    expect(screen.getByTestId("top-level-surface-epic-epic-a")).toBeTruthy();
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
  });

  it("still navigates, activating Settings, when Settings owns focus", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    seedSplit({
      partner: "task",
      focusedSide: "right",
      routeBackingSide: "right",
    });
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 3 } });
    const router = buildRouter("/settings/appearance");
    renderApp(router);
    await waitForGuideOnAppearance();
    expect(settingsSurface().dataset.focused).toBe("true");

    narrowWindow();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/layout"),
    );
    await waitFor(() =>
      expect(
        settingsSurface().querySelector("[data-testid='layout-presets-group']"),
      ).not.toBeNull(),
    );
    expect(splitState().focusedSide).toBe("right");
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
  });

  // The route can stay on Settings while focus is elsewhere: focusing an EMPTY
  // slot keeps route-backing on the populated side. Settings then still draws
  // the ROUTE, and any route change re-focuses Settings - so the guide cannot
  // follow without taking focus, and defers until Settings has it back.
  it("defers, without taking focus or the route, while an empty slot is focused, and follows once Settings regains focus", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    seedSplit({
      partner: "empty",
      focusedSide: "right",
      routeBackingSide: "right",
    });
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 3 } });
    const router = buildRouter("/settings/appearance");
    renderApp(router);
    await waitForGuideOnAppearance();
    // Focus the empty slot through the real slot handler, as a click does.
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("top-level-fillable-slot-left"));
    });
    await waitFor(() => expect(splitState().focusedSide).toBe("left"));
    // Route-backing stayed with Settings, which is on screen but unfocused.
    expect(splitState()).toEqual({
      focusedSide: "left",
      routeBackingSide: "right",
    });
    expect(settingsSurface().dataset.visible).toBe("true");
    expect(settingsSurface().dataset.focused).toBe("false");
    const before = splitState();

    narrowWindow();

    // Nothing moved: the empty slot kept focus, the route stayed, and Settings
    // still shows Appearance (its guide waits, hidden, for its step's section).
    expect(splitState()).toEqual(before);
    expect(router.state.location.pathname).toBe("/settings/appearance");
    expect(
      settingsSurface().querySelector("[data-testid='layout-presets-group']"),
    ).toBeNull();
    expect(
      settingsSurface().querySelector("[data-testid='guide-coachmark']"),
    ).toBeNull();
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });

    // Settings regains focus (the coordinator command a click on its side
    // issues): the deferred follow lands.
    act(() => {
      tabCommandCoordinator.focusSplitSide({ splitId: "pair", side: "right" });
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/layout"),
    );
    await waitFor(() =>
      expect(
        settingsSurface().querySelector("[data-testid='layout-presets-group']"),
      ).not.toBeNull(),
    );
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
