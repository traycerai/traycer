import "../../../../../__tests__/test-browser-apis";

/**
 * The mobile drawer's Home row is the phone's ONLY way back to the always-
 * available Home surface: the desktop tab strip, its route guard and its
 * keybinding chord are all hidden on the phone shell, so this row is the sole
 * entry point there. It exists only while the `homeTabEnabled` settings flag
 * is on, and it must sit ABOVE "New task" - the drawer's one filled, primary
 * action - so a thumb reaching for the drawer's first row lands on returning
 * home before it lands on starting something new. A tap must both close the
 * drawer AND actually select Home in the shared tab layout (`activeItemId`
 * clears to `null` while every open item is preserved) - closing the drawer
 * while leaving the previously active tab still selected underneath it would
 * be a silent no-op dressed up as navigation.
 *
 * This is a SEPARATE file rather than an extension of
 * `mobile-nav-drawer.test.tsx` because that file's shared, file-wide
 * `vi.mock("@/lib/tab-navigation", ...)` only stubs `draftTabIntent` /
 * `navigateToTabIntent` - names the component no longer imports. It is inert
 * today only because nothing in that file ever clicks "New task" or "Home";
 * exercising the Home tap for real needs the actual `activateTabIntent` ->
 * `tabCommandCoordinator.activateTab` -> `useTabsStore` pipeline, which
 * reusing that stale mock would silently break. `@tanstack/react-router`'s
 * `useNavigate` is swapped for a capturing stub here instead of using a real
 * router destination, since the store mutation this suite cares about is
 * committed by `tabCommandCoordinator.activateTab` BEFORE
 * `TabNavigationController` ever calls `navigate(...)` (see
 * `executeActivation` in `src/lib/tab-navigation.ts`), and the shared
 * `TestRouterProvider` only defines a root route - too thin to resolve a real
 * Home destination.
 */

import type { UseNavigateResult } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "../../../../__tests__/with-test-router";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { setMobileApp } from "@/lib/mobile-app";
import * as TabNav from "@/lib/tab-navigation";
import { existingEpicTabIntent } from "@/lib/tab-navigation/intents";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";

// One-time, real reconciliation install - mirrors `tab-navigation.test.ts`,
// the only other suite that drives `activateTabIntent` against real stores.
installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const navigateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// `vi.fn(() => Promise.resolve())` already satisfies the navigate signature, so
// this names the seam rather than casting to it.
function asNavigate(mock: typeof navigateMock): UseNavigateResult<string> {
  return mock;
}

// The store mutation under test is committed before `navigate()` runs, so a
// capturing stub is enough - real route resolution is exercised elsewhere
// (`tab-navigation.test.ts`). Every other export (the in-memory router
// primitives `TestRouterProvider` itself builds on) stays real.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => asNavigate(navigateMock) };
});

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: () => "idle",
}));

vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));

const openLink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: {
    SettingsOpened: "SettingsOpened",
    SubscriptionManagementOpened: "SubscriptionManagementOpened",
    SignOutRequested: "SignOutRequested",
  },
  Analytics: { getInstance: () => ({ track: trackMock }) },
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({ signOut: () => Promise.resolve() }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.test",
    signInUrl: "https://platform.test/sign-in",
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: () => undefined,
    openHistory: () => undefined,
  }),
}));

// Never invoked by these tests (nothing here clicks "New task"), but the
// component imports it unconditionally, so it needs a stub that matches the
// CURRENT export name - unlike `mobile-nav-drawer.test.tsx`'s stale
// `openNewEpicDraft` stub, which the component stopped importing.
vi.mock("@/lib/commands/actions/new-epic", () => ({
  openNewEpicIntent: () => ({ kind: "new-draft", settings: null }),
}));

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: { items: [], totalCount: 0 },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

/**
 * Mirrors `mobile-nav-drawer.test.tsx`'s `renderDrawer`: `LazyMotion` is what
 * the installed-app panel needs to exist at all, and `TestRouterProvider`
 * gives `useNavigate` / `useRouterState` a real (if root-only) router.
 */
function renderDrawer(): void {
  render(
    <LazyMotion features={domMax}>
      <TestRouterProvider>
        <MobileNavDrawer />
      </TestRouterProvider>
    </LazyMotion>,
  );
}

describe("MobileNavDrawer Home row", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    navigateMock.mockClear();
    openLink.mockClear();
    trackMock.mockClear();
    useMobileNavStore.setState({ open: true });
    useAuthStore.setState({
      profile: {
        userId: "u1",
        userName: "devansh",
        email: "devansh@traycer.ai",
        avatarUrl: null,
      },
    });
    useSettingsStore.setState({ homeTabEnabled: false });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    TabNav.__resetTabNavigationControllerForTesting();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useMobileNavStore.setState({ open: false });
    useAuthStore.setState({ profile: null });
    // Reset LAST, and to the disabled default: a leaked `true` here would
    // silently turn the Home row on for every other suite that renders the
    // drawer after this file runs in the same worker.
    useSettingsStore.setState({ homeTabEnabled: false });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    setMobileApp(false);
  });

  it("renders above New task when the Home tab is enabled", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    renderDrawer();

    const home = await screen.findByTestId("mobile-nav-home");
    const newTask = screen.getByTestId("mobile-nav-new-task");

    // `DOCUMENT_POSITION_FOLLOWING` on the result means "newTask comes after
    // home" - i.e. Home precedes New task in DOM order, not just visually.
    expect(
      home.compareDocumentPosition(newTask) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("is absent from the drawer when the Home tab is disabled", async () => {
    useSettingsStore.setState({ homeTabEnabled: false });
    renderDrawer();
    await screen.findByTestId("mobile-nav-new-task");

    expect(screen.queryByTestId("mobile-nav-home")).toBeNull();
  });

  it("closes the drawer and selects Home, preserving the open tab", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    // Seed a real, already-active epic tab through the same activation seam
    // the component uses, so the click has a concrete prior selection to
    // clear rather than starting from an already-empty layout.
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Alpha");
    TabNav.activateTabIntent(
      asNavigate(navigateMock),
      existingEpicTabIntent({ epicId: "epic-1", tabId, focus: undefined }),
      undefined,
    );
    expect(useTabsStore.getState().activeItemId).toBe(
      tabItemId({ kind: "epic", id: tabId }),
    );
    expect(useTabsStore.getState().items.length).toBe(1);

    renderDrawer();
    fireEvent.click(await screen.findByTestId("mobile-nav-home"));

    expect(useMobileNavStore.getState().open).toBe(false);
    // Home is a selection, not a placement: it clears the active item without
    // dropping it from the layout.
    expect(useTabsStore.getState().activeItemId).toBeNull();
    expect(useTabsStore.getState().items.length).toBe(1);
  });
});
