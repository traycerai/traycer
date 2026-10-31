import "../../../../../__tests__/test-browser-apis";

/**
 * The mobile drawer's Home row is the phone's ONLY way back to the always-
 * available Home surface: the desktop tab strip, its route guard and its
 * keybinding chord are all hidden on the phone shell, so this row is the sole
 * entry point there. It exists only while the layout store's `homeTab.shown`
 * value is on, and it must sit ABOVE "New task" - the drawer's one filled,
 * primary action - so a thumb reaching for the drawer's first row lands on
 * returning home before it lands on starting something new. A tap must both
 * close the drawer AND actually select Home in the shared tab layout
 * (`activeItemId` clears to `null` while every open item is preserved) -
 * closing the drawer while leaving the previously active tab still selected
 * underneath it would be a silent no-op dressed up as navigation.
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
 *
 * The fixed Tracy row beneath Home is covered here too, over the same real
 * pipeline: it opens as the desktop strip's entry does, first moving a tab
 * whose host this client can no longer dial onto this window's host.
 */

import type { UseNavigateResult } from "@tanstack/react-router";
import type { HostNotificationsIndicatorState } from "@traycer/protocol/host/notifications/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { domMax, LazyMotion } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "../../../../__tests__/with-test-router";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { setMobileApp } from "@/lib/mobile-app";
import * as TabNav from "@/lib/tab-navigation";
import { existingEpicTabIntent } from "@/lib/tab-navigation/intents";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { TRACY_TAB_REF } from "@/stores/tabs/kinds/tracy";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

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

// The Tracy row reads this window's host and the hosts this client can dial;
// the directory behind them needs a host runtime this suite does not mount.
const directory = vi.hoisted(
  (): { connectable: { hostIds: readonly string[]; resolved: boolean } } => ({
    connectable: { hostIds: [], resolved: true },
  }),
);
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => directory.connectable,
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: () => "idle",
}));

// The in-progress lift (`useInProgressHistoryItems`) backfills a running task
// no listed page carries through `epic.getTaskContexts`, which needs a host
// runtime this suite deliberately does not mount. Inert here: nothing is
// running in these fixtures, so the lift has nothing to lift either way.
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(),
    localHomedTaskIds: new Set<string>(),
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    refetchBatches: [],
  }),
}));

// The notification host's answer for the bot's epic; each test sets it.
const indicators = vi.hoisted(
  (): { epics: Record<string, HostNotificationsIndicatorState> } => ({
    epics: {},
  }),
);
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: indicators.epics, chats: {} }),
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
    // The drawer asks the mutation cache whether a tapped row's task is being
    // deleted, so it mounts inside a client like the rest of the app.
    <QueryClientProvider client={new QueryClient()}>
      <LazyMotion features={domMax}>
        <TestRouterProvider>
          <MobileNavDrawer />
        </TestRouterProvider>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

function setHomeTabEnabled(enabled: boolean): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore
    .getState()
    .setRegionValues("homeTab", { shown: enabled ? "shown" : "hidden" });
}

const TRACY: TabRef = TRACY_TAB_REF;
/** The channel the Tracy surface shows, whose unread state the row carries. */
const TRACY_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("MobileNavDrawer rows", () => {
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
    setHomeTabEnabled(false);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    TabNav.__resetTabNavigationControllerForTesting();
    directory.connectable = { hostIds: [], resolved: true };
    indicators.epics = {};
    useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
    // The window's host, which a surface the row opens is bound to.
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-a" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useMobileNavStore.setState({ open: false });
    useAuthStore.setState({ profile: null });
    // Reset LAST, and to the disabled default: a leaked `true` here would
    // silently turn the Home row on for every other suite that renders the
    // drawer after this file runs in the same worker.
    setHomeTabEnabled(false);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
    setMobileApp(false);
  });

  it("renders above New task when the Home tab is enabled", async () => {
    setHomeTabEnabled(true);
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
    setHomeTabEnabled(false);
    renderDrawer();
    await screen.findByTestId("mobile-nav-new-task");

    expect(screen.queryByTestId("mobile-nav-home")).toBeNull();
  });

  it("closes the drawer and selects Home, preserving the open tab", async () => {
    setHomeTabEnabled(true);
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

  it("opens the Tracy row's surface on this window's host when its own host can no longer be dialled, and closes the drawer", async () => {
    directory.connectable = { hostIds: ["host-a"], resolved: true };
    useTracySurfaceStore.setState({
      open: true,
      hostId: "host-gone",
      botId: TRACY_BOT_ID,
      visitedBotIds: [],
    });
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      items: [{ kind: "tab", id: tabItemId(TRACY), ref: TRACY }],
      stripOrder: [TRACY],
    });
    renderDrawer();

    const row = await screen.findByTestId("mobile-nav-tracy");
    expect(row.textContent).toBe("Tracy");
    expect(within(row).getByTestId("tracy-entry-icon")).toBeTruthy();
    fireEvent.click(row);

    expect(useTracySurfaceStore.getState().hostId).toBe("host-a");
    expect(useMobileNavStore.getState().open).toBe(false);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(TRACY));
  });

  describe("the Tracy row's unread count", () => {
    function openTracyRow(): void {
      useTracySurfaceStore.setState({
        open: true,
        hostId: "host-a",
        botId: TRACY_BOT_ID,
        visitedBotIds: [],
      });
      useTabsStore.setState({
        ...emptyTabStripLayout(),
        items: [{ kind: "tab", id: tabItemId(TRACY), ref: TRACY }],
        stripOrder: [TRACY],
      });
    }

    function tracyIndicators(
      unreadDone: boolean,
      unreadCount: number | null,
    ): void {
      indicators.epics = {
        [TRACY_BOT_ID]: {
          pendingApproval: false,
          pendingInterview: false,
          pendingFork: false,
          unreadFailure: false,
          unreadDone,
          unreadCount,
        },
      };
    }

    it.each([
      { unreadCount: 3, shown: "3" },
      { unreadCount: 120, shown: "99+" },
    ])(
      "draws $shown on the glyph and names it, bold",
      async ({ unreadCount, shown }) => {
        openTracyRow();
        tracyIndicators(true, unreadCount);
        renderDrawer();

        const row = await screen.findByTestId("mobile-nav-tracy");
        expect(
          within(row).getByTestId("tracy-entry-unread-count").textContent,
        ).toBe(shown);
        expect(row.getAttribute("aria-label")).toBe(`Tracy, ${shown} unread`);
        expect(row.hasAttribute("data-unread")).toBe(true);
        expect(within(row).getByText("Tracy").className).toContain(
          "font-semibold",
        );
      },
    );

    it("draws no count at zero", async () => {
      openTracyRow();
      tracyIndicators(false, 0);
      renderDrawer();

      const row = await screen.findByTestId("mobile-nav-tracy");
      expect(within(row).queryByTestId("tracy-entry-unread-count")).toBeNull();
      expect(row.getAttribute("aria-label")).toBe("Tracy");
      expect(row.hasAttribute("data-unread")).toBe(false);
    });

    it("keeps the bold name and draws no count for a host that does not count", async () => {
      openTracyRow();
      tracyIndicators(true, null);
      renderDrawer();

      const row = await screen.findByTestId("mobile-nav-tracy");
      expect(within(row).queryByTestId("tracy-entry-unread-count")).toBeNull();
      expect(row.getAttribute("aria-label")).toBe("Tracy");
      expect(row.hasAttribute("data-unread")).toBe(true);
      expect(within(row).getByText("Tracy").className).toContain(
        "font-semibold",
      );
    });
  });
});
