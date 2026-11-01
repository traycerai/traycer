import { create } from "zustand";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";

/**
 * The Tracy channel a task's tab was opened from, per tab, for the pane header's
 * way back (leaving a task opened from Tracy returns to that channel, not to
 * Home, whichever channel the surface has moved to since). Session-only: after a
 * restart there is no opening to return along.
 *
 * Installed app only, where the pane header draws it.
 */
interface MobileTabOriginState {
  readonly botIdByTabId: Readonly<Record<string, string>>;
  readonly clear: (tabId: string) => void;
  /** The channel's bot is gone: there is nothing to return to. */
  readonly forgetBot: (botId: string) => void;
  /** The surface closed: reopening it later is not where these tasks came from. */
  readonly clearAll: () => void;
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
  clearAll: () => {
    set((state) =>
      Object.keys(state.botIdByTabId).length === 0
        ? state
        : { botIdByTabId: {} },
    );
  },
}));

/**
 * A task opened: `channelBotId` is the channel Tracy showed in front when it
 * did, and `null`, for any other opening, means the way back no longer leads
 * where the person came from.
 */
export function recordMobileTabOrigin(
  tabId: string,
  channelBotId: string | null,
): void {
  if (!isPhoneLayoutOnly()) return;
  if (channelBotId === null) {
    useMobileTabOriginStore.getState().clear(tabId);
    return;
  }
  useMobileTabOriginStore.setState((state) => ({
    botIdByTabId: { ...state.botIdByTabId, [tabId]: channelBotId },
  }));
}
