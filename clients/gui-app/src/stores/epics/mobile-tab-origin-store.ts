import { create } from "zustand";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The bot a task's tab was opened from, per tab, for the pane header's way back
 * (leaving a task opened from Tracy returns there, not to Home). Session-only:
 * after a restart there is no opening to return along.
 *
 * Installed app only, where the pane header draws it.
 */
interface MobileTabOriginState {
  readonly botIdByTabId: Readonly<Record<string, string>>;
  readonly clear: (tabId: string) => void;
  /** The bot's tab closed: reopening it later is not the tab these tasks came from. */
  readonly forgetBot: (botId: string) => void;
}

export const useMobileTabOriginStore = create<MobileTabOriginState>((set) => ({
  botIdByTabId: {},
  clear: (tabId) => {
    set((state) => {
      if (!Object.hasOwn(state.botIdByTabId, tabId)) return state;
      const { [tabId]: _cleared, ...others } = state.botIdByTabId;
      return { botIdByTabId: others };
    });
  },
  forgetBot: (botId) => {
    set((state) => {
      const kept = Object.entries(state.botIdByTabId).filter(
        ([, origin]) => origin !== botId,
      );
      return kept.length === Object.keys(state.botIdByTabId).length
        ? state
        : { botIdByTabId: Object.fromEntries(kept) };
    });
  },
}));

/**
 * A task opened, from whichever tab was in front: a bot's is its origin, and any
 * other opening means the way back no longer leads where the person came from.
 */
export function recordMobileTabOrigin(
  tabId: string,
  from: TabRef | null,
): void {
  if (!isPhoneLayoutOnly()) return;
  if (from?.kind !== "bot") {
    useMobileTabOriginStore.getState().clear(tabId);
    return;
  }
  useMobileTabOriginStore.setState((state) => ({
    botIdByTabId: { ...state.botIdByTabId, [tabId]: from.id },
  }));
}
