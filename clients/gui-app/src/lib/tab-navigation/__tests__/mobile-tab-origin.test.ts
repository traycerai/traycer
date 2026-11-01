/**
 * The way back from a task to the bot it was opened from is recorded where every
 * task opening passes: the navigation controller. These cases drive that real
 * controller and read what the origin store kept.
 */
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as TabNav from "@/lib/tab-navigation";
import {
  botTabIntent,
  existingEpicTabIntent,
  homeTabIntent,
  openEpicTabIntent,
} from "@/lib/tab-navigation/intents";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";
import { useTabsStore } from "@/stores/tabs/store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const navigate = vi.fn((_options: NavigateOptions) => Promise.resolve());
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

function focusBotTab(botId: string): void {
  useBotTabsStore
    .getState()
    .openBotTab({ botId, hostId: "host-A", title: "Tracy" });
  TabNav.navigateToTabIntent(navigateFn, botTabIntent(botId), undefined);
}

function openEpicFromFocusedTab(epicId: string): string {
  TabNav.navigateToTabIntent(
    navigateFn,
    openEpicTabIntent({ epicId, focus: undefined }),
    undefined,
  );
  const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(epicId);
  if (tabId === null) throw new Error("the task did not get a tab");
  return tabId;
}

describe("mobile tab origin", () => {
  beforeEach(() => {
    resetStores();
    setPhoneLayoutOnly(true);
  });
  afterEach(() => {
    setPhoneLayoutOnly(false);
    resetStores();
  });

  it("records the bot a task was opened from while the bot's tab is focused", () => {
    focusBotTab("bot-1");
    const tabId = openEpicFromFocusedTab("epic-1");
    expect(useMobileTabOriginStore.getState().botIdByTabId).toEqual({
      [tabId]: "bot-1",
    });
  });

  it("clears the origin when the task is opened from any other tab", () => {
    focusBotTab("bot-1");
    const tabId = openEpicFromFocusedTab("epic-1");
    TabNav.navigateToTabIntent(navigateFn, homeTabIntent(), undefined);
    openEpicFromFocusedTab("epic-1");
    expect(useMobileTabOriginStore.getState().botIdByTabId).not.toHaveProperty(
      tabId,
    );
  });

  it("leaves the origin alone when the strip activates the task's tab", () => {
    focusBotTab("bot-1");
    const tabId = openEpicFromFocusedTab("epic-1");
    TabNav.navigateToTabIntent(navigateFn, homeTabIntent(), undefined);
    TabNav.navigateToTabIntent(
      navigateFn,
      existingEpicTabIntent({ epicId: "epic-1", tabId, focus: undefined }),
      undefined,
    );
    expect(useMobileTabOriginStore.getState().botIdByTabId).toEqual({
      [tabId]: "bot-1",
    });
  });

  it("records nothing off the installed app", () => {
    setPhoneLayoutOnly(false);
    focusBotTab("bot-1");
    openEpicFromFocusedTab("epic-1");
    expect(useMobileTabOriginStore.getState().botIdByTabId).toEqual({});
  });
});
