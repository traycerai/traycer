import { createRoot } from "react-dom/client";
import { LazyMotion, domMax } from "motion/react";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { TRACY_TAB_REF } from "@/stores/tabs/kinds/tracy";
import { useTabsStore } from "@/stores/tabs/store";
import { FixtureApp } from "./bot-compact-actions-menu-frame";
import { HOST_ID, useSelectedBotId } from "./bot-compact-actions-menu-host";

/**
 * The real Tracy surface under the shell's real edge recognizer, with the
 * Tracy tab focused as it is in the installed app. Two probes make what the
 * swipe did readable: how many times the picker's registered swipe-open was
 * called, and whether the task drawer was opened.
 */
declare global {
  interface Window {
    __pickerSwipeOpens?: number;
    __mobileNavOpen?: () => boolean;
  }
}

useTabsStore.setState({
  items: [{ kind: "tab", id: "tracy-item", ref: TRACY_TAB_REF }],
  activeItemId: "tracy-item",
  stripOrder: [TRACY_TAB_REF],
});

window.__pickerSwipeOpens = 0;
window.__mobileNavOpen = () => useMobileNavStore.getState().open;
const registerSwipeOpen = useMobileSwitcherStore.getState().registerSwipeOpen;
useMobileSwitcherStore.setState({
  registerSwipeOpen: (tabId, open) =>
    registerSwipeOpen(tabId, () => {
      window.__pickerSwipeOpens = (window.__pickerSwipeOpens ?? 0) + 1;
      open();
    }),
});

export function EdgeSwipeFixture() {
  const transition = useMobileHistorySwipes();
  return (
    <LazyMotion features={domMax} strict>
      <BotTabSurface botId={useSelectedBotId()} hostId={HOST_ID} />
      {transition}
    </LazyMotion>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("the fixture needs a #root");
createRoot(root).render(
  <FixtureApp>
    <EdgeSwipeFixture />
  </FixtureApp>,
);
