import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTileOriginCrumb } from "@/components/epic-canvas/mobile/mobile-tile-header-actions";
import * as TabNav from "@/lib/tab-navigation";
import { botRoute } from "@/lib/routes";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  botTabIntent,
  homeTabIntent,
  openEpicTabIntent,
} from "@/lib/tab-navigation/intents";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";
import { useTabsStore } from "@/stores/tabs/store";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

// The crumb navigates through the router's `navigate`; one recorder stands for
// it here and for the call that opens the task.
const navigate = vi.hoisted(() =>
  vi.fn((_options: NavigateOptions) => Promise.resolve()),
);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
const navigateFn = navigate as UseNavigateResult<string>;

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useBotTabsStore.setState({ tabs: {}, fixedBotId: null });
  useMobileTabOriginStore.setState({ botIdByTabId: {} });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  TabNav.__resetTabNavigationControllerForTesting();
  navigate.mockClear();
}

/** A task opened from the bot's focused tab, as a chip in Tracy's messages opens it. */
function openTaskFromBot(title: string, botId: string, epicId: string): string {
  useBotTabsStore.getState().openBotTab({ botId, hostId: "host-A", title });
  TabNav.navigateToTabIntent(navigateFn, botTabIntent(botId), undefined);
  TabNav.navigateToTabIntent(
    navigateFn,
    openEpicTabIntent({ epicId, focus: undefined }),
    undefined,
  );
  const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(epicId);
  if (tabId === null) throw new Error("the task did not get a tab");
  return tabId;
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

  it("draws the way back to the bot a task was opened from", () => {
    const tabId = openTaskFromBot("Tracy", "bot-1", "epic-1");
    render(<MobileTileOriginCrumb tabId={tabId} />);
    expect(
      screen.getByRole("button", { name: "Back to Tracy" }),
    ).not.toBeNull();
  });

  it("draws nothing for a task opened from another tab", () => {
    const tabId = openTaskFromBot("Tracy", "bot-1", "epic-1");
    TabNav.navigateToTabIntent(navigateFn, homeTabIntent(), undefined);
    TabNav.navigateToTabIntent(
      navigateFn,
      openEpicTabIntent({ epicId: "epic-1", focus: undefined }),
      undefined,
    );
    render(<MobileTileOriginCrumb tabId={tabId} />);
    expect(screen.queryByTestId("mobile-tile-origin-crumb")).toBeNull();
  });

  it("draws nothing once the bot's tab is gone", () => {
    const tabId = openTaskFromBot("Tracy", "bot-1", "epic-1");
    render(<MobileTileOriginCrumb tabId={tabId} />);
    act(() => useBotTabsStore.getState().closeBotTab("bot-1"));
    expect(screen.queryByTestId("mobile-tile-origin-crumb")).toBeNull();
  });

  it("goes back to the bot's tab and spends the origin", () => {
    const tabId = openTaskFromBot("Tracy", "bot-1", "epic-1");
    render(<MobileTileOriginCrumb tabId={tabId} />);
    navigate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Back to Tracy" }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining(botRoute("bot-1")),
    );
    expect(useMobileTabOriginStore.getState().botIdByTabId).not.toHaveProperty(
      tabId,
    );
    expect(screen.queryByTestId("mobile-tile-origin-crumb")).toBeNull();
  });
  it("does not bring the way back with a reopened bot tab, and leaves another bot's origin alone", () => {
    const closedBotTask = openTaskFromBot("Tracy", "bot-1", "epic-1");
    const otherBotTask = openTaskFromBot("Helper", "bot-2", "epic-2");
    act(() => useBotTabsStore.getState().closeBotTab("bot-1"));
    useBotTabsStore
      .getState()
      .openBotTab({ botId: "bot-1", hostId: "host-A", title: "Tracy" });

    render(
      <>
        <MobileTileOriginCrumb tabId={closedBotTask} />
        <MobileTileOriginCrumb tabId={otherBotTask} />
      </>,
    );
    expect(screen.queryByRole("button", { name: "Back to Tracy" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Back to Helper" }),
    ).not.toBeNull();
  });
});
