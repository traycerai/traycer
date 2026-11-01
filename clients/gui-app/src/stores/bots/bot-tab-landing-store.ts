import { create } from "zustand";

/**
 * Where a bot's tab is asked to land from outside it, on a row where
 * `messageId` names one:
 *  - `thread` (a tapped push): a thread beside the channel, or the channel
 *    itself (`threadId` `null`);
 *  - `chat` (a chat search hit, a session link): one of the bot's chats by
 *    its id, which the tab resolves to its channel, a thread, or a session;
 *  - `sender` (a message's sender chip): the session that sent it, whose
 *    thread shows beside the channel, or the channel for the trunk.
 */
export type BotTabLanding =
  | {
      readonly kind: "thread";
      readonly threadId: string | null;
      readonly messageId: string | null;
    }
  | {
      readonly kind: "chat";
      readonly chatId: string;
      readonly messageId: string | null;
    }
  | { readonly kind: "sender"; readonly chatId: string };

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
