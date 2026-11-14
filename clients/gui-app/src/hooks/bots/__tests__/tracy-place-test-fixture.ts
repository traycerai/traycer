import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

export const WINDOW_HOST = "host-window";

export function resetTracyPlaceStores(): void {
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
    goneReports: {},
  });
  useTracyPlaceStore.setState(useTracyPlaceStore.getInitialState(), true);
  useBotOpenThreadStore.setState(useBotOpenThreadStore.getInitialState(), true);
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
  useBotTabLandingStore.setState(useBotTabLandingStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({
    attached: true,
    effectiveHostId: WINDOW_HOST,
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  tabCommandCoordinator.resetReconciliationForTesting();
  __resetTabNavigationControllerForTesting();
}

export function railOf(botId: string): BotRail | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  return Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
}
