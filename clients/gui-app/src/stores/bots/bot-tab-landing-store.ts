import { create } from "zustand";

/**
 * Where a bot's tab is asked to land from outside it (a tapped push): a
 * thread beside the channel, on one of its rows, or the channel itself
 * (`threadId` `null`), on a row of it where `messageId` names one.
 */
export interface BotTabLanding {
  readonly threadId: string | null;
  readonly messageId: string | null;
}

interface BotTabLandingState {
  readonly byBotId: Readonly<Record<string, BotTabLanding>>;
  /** Asks `botId`'s tab to land there; a later request replaces an unspent one. */
  readonly request: (botId: string, landing: BotTabLanding) => void;
  /** Spends `botId`'s request: the tab has landed. */
  readonly clear: (botId: string) => void;
}

/**
 * Landings asked of bot tabs, each spent once by the tab it names when it
 * can land it (`BotTabContent`). Not persisted: a restart opens the channel.
 */
export const useBotTabLandingStore = create<BotTabLandingState>()((set) => ({
  byBotId: {},
  request: (botId, landing) =>
    set((state) => ({ byBotId: { ...state.byBotId, [botId]: landing } })),
  clear: (botId) =>
    set((state) => {
      if (!Object.hasOwn(state.byBotId, botId)) return state;
      const next = { ...state.byBotId };
      delete next[botId];
      return { byBotId: next };
    }),
}));
