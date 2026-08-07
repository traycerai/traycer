import "../../../../../__tests__/test-browser-apis";

import type { HistoryItem } from "@/components/home/data/home-page.data";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Fixed "now" so the bucketed timestamp labels are deterministic. The rows read
// `updatedAtMs`, so each fixture is expressed as an offset from this.
const NOW_MS = Date.UTC(2026, 6, 30, 12, 0, 0);

const testState: {
  items: ReadonlyArray<HistoryItem>;
  signOut: () => Promise<void>;
  openExternalLink: (url: string) => Promise<void>;
  openSettings: () => void;
} = {
  items: [],
  signOut: () => Promise.resolve(),
  openExternalLink: () => Promise.resolve(),
  openSettings: () => undefined,
};

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: { items: testState.items, totalCount: testState.items.length },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: {
    SettingsOpened: "SettingsOpened",
    SubscriptionManagementOpened: "SubscriptionManagementOpened",
    SignOutRequested: "SignOutRequested",
  },
  Analytics: { getInstance: () => ({ track: () => undefined }) },
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({ signOut: () => testState.signOut() }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.test",
    openExternalLink: (url: string) => testState.openExternalLink(url),
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: () => testState.openSettings(),
    openHistory: () => undefined,
  }),
}));

vi.mock("@/lib/commands/actions/new-epic", () => ({
  openNewEpicDraft: () => ({ kind: "draft" }),
}));

vi.mock("@/lib/tab-navigation", () => ({
  draftTabIntent: (value: unknown) => value,
  navigateToTabIntent: () => undefined,
}));

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "../../../../__tests__/with-test-router";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

function historyItem(overrides: {
  readonly id: string;
  readonly title: string;
  readonly updatedAtMs: number;
}): HistoryItem {
  return {
    id: overrides.id,
    epicId: overrides.id,
    taskType: "epic",
    title: overrides.title,
    initialUserPrompt: "",
    updatedAtMs: overrides.updatedAtMs,
    updatedLabel: "about 1 month ago",
    updatedBucket: "earlier",
    linkedRepos: [],
    linkedWorkspaces: [],
    worktreeBranches: [],
    worktreePaths: [],
    pullRequestNumbers: [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

function renderDrawer() {
  render(
    <TestRouterProvider>
      <MobileNavDrawer />
    </TestRouterProvider>,
  );
}

describe("MobileNavDrawer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW_MS);
    testState.items = [];
    testState.signOut = () => Promise.resolve();
    testState.openExternalLink = () => Promise.resolve();
    testState.openSettings = () => undefined;
    useMobileNavStore.setState({ open: true });
    useAuthStore.setState({
      profile: {
        userId: "u1",
        userName: "devansh",
        email: "devansh@traycer.ai",
        avatarUrl: null,
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useMobileNavStore.setState({ open: false });
    useAuthStore.setState({ profile: null });
  });

  describe("identity row", () => {
    it("reaches both account actions in one tap", async () => {
      renderDrawer();

      expect(
        await screen.findByTestId("mobile-nav-manage-subscription"),
      ).not.toBeNull();
      expect(screen.queryByTestId("mobile-nav-sign-out")).not.toBeNull();
      // Settings stays pinned in the footer rather than joining the identity
      // row's icon pair.
      expect(screen.queryByTestId("mobile-nav-settings")).not.toBeNull();
    });

    // Both controls are icon-only, and Radix tooltips never open on touch - the
    // accessible name is the only label a phone user's screen reader gets.
    it("names both icon-only controls", async () => {
      renderDrawer();

      expect(
        (
          await screen.findByTestId("mobile-nav-manage-subscription")
        ).getAttribute("aria-label"),
      ).toBe("Manage subscription");
      expect(
        screen.getByTestId("mobile-nav-sign-out").getAttribute("aria-label"),
      ).toBe("Sign out");
    });

    it("opens the subscription page through the runner host", async () => {
      const opened: string[] = [];
      testState.openExternalLink = (url) => {
        opened.push(url);
        return Promise.resolve();
      };
      renderDrawer();
      fireEvent.click(
        await screen.findByTestId("mobile-nav-manage-subscription"),
      );

      expect(opened.length).toBe(1);
      // `resolveManageSubscriptionUrl` swaps the `authn.*` label for its
      // `platform.*` sibling.
      expect(opened[0]).toContain("platform.test");
      expect(useMobileNavStore.getState().open).toBe(false);
    });

    it("confirms before signing out, then closes the drawer", async () => {
      let signedOut = 0;
      testState.signOut = () => {
        signedOut += 1;
        return Promise.resolve();
      };
      renderDrawer();
      fireEvent.click(await screen.findByTestId("mobile-nav-sign-out"));

      // The tap only asks. Unlike its neighbours this control leaves the
      // drawer open, so cancelling returns the user where they were.
      expect(signedOut).toBe(0);
      expect(useMobileNavStore.getState().open).toBe(true);

      fireEvent.click(await screen.findByTestId("confirm-action"));

      expect(signedOut).toBe(1);
      expect(useMobileNavStore.getState().open).toBe(false);
    });

    it("keeps the session and the drawer when the confirm is cancelled", async () => {
      let signedOut = 0;
      testState.signOut = () => {
        signedOut += 1;
        return Promise.resolve();
      };
      renderDrawer();
      fireEvent.click(await screen.findByTestId("mobile-nav-sign-out"));
      fireEvent.click(await screen.findByTestId("confirm-cancel"));

      await waitFor(() => {
        expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      });
      expect(signedOut).toBe(0);
      expect(useMobileNavStore.getState().open).toBe(true);
    });

    // Notifications live in the header now (`MobileNotificationsButton`), so
    // an unresolved profile simply drops the whole account block, actions
    // included.
    it("drops the account block when no profile has resolved", async () => {
      useAuthStore.setState({ profile: null });
      renderDrawer();
      await screen.findByTestId("mobile-nav-new-task");

      expect(screen.queryByTestId("mobile-nav-manage-subscription")).toBeNull();
      expect(screen.queryByTestId("mobile-nav-sign-out")).toBeNull();
    });
  });

  describe("task rows", () => {
    it("labels rows with the compact bucketed timestamp, not the verbose one", async () => {
      testState.items = [
        historyItem({
          id: "a",
          title: "hello",
          updatedAtMs: NOW_MS - 2 * HOUR_MS,
        }),
        historyItem({
          id: "b",
          title: "neww",
          updatedAtMs: NOW_MS - 30 * DAY_MS,
        }),
      ];
      renderDrawer();
      const rows = await screen.findAllByTestId("mobile-nav-task-row");

      expect(rows.length).toBe(2);
      expect(rows[0]?.textContent).toContain("2h ago");
      // The shared verbose label stays on the item for the landing list / tray;
      // this surface must not render it.
      expect(rows[1]?.textContent).not.toContain("about 1 month ago");
    });

    it("renders no leading glyph on a task row", async () => {
      testState.items = [
        historyItem({ id: "a", title: "hello", updatedAtMs: NOW_MS - DAY_MS }),
      ];
      renderDrawer();
      const rows = await screen.findAllByTestId("mobile-nav-task-row");

      expect(rows[0]?.querySelector("svg")).toBeNull();
    });
  });
});
