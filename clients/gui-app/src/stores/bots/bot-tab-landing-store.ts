import { create } from "zustand";

/**
 * Where a bot's tab is asked to land from outside it, on a row where
 * `messageId` names one:
 *  - `thread` (a tapped push): a thread beside the channel, or the channel
 *    itself (`threadId` `null`);
 *  - `chat` (a chat search hit, a session link, a Threads card's receipt):
 *    one of the bot's chats by its id, which the tab resolves to its
 *    channel, a thread, or a session; a session lands on the card of the
 *    send that wrote `sendPostId` where it has one (T94);
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
      readonly sendPostId: string | null;
    }
  | { readonly kind: "sender"; readonly chatId: string };

/** A landing on one message of a thread: what a notification of a reply asks for. */
export type BotThreadMessageLanding = Extract<
  BotTabLanding,
  { kind: "thread" }
> & { readonly threadId: string; readonly messageId: string };

/**
 * Whether `landing` names a message inside a thread. An opening of a thread
 * itself (a Threads card, a thread chip) names no message, and a channel's
 * row names no thread.
 */
export function isBotThreadMessageLanding(
  landing: BotTabLanding,
): landing is BotThreadMessageLanding {
  return (
    landing.kind === "thread" &&
    landing.threadId !== null &&
    landing.messageId !== null
  );
}

interface BotTabLandingState {
  readonly byBotId: Readonly<Record<string, BotTabLanding>>;
  /** Asks `botId`'s tab to land there; a later request replaces an unspent one. */
  readonly request: (botId: string, landing: BotTabLanding) => void;
  /** Spends `botId`'s request: the tab has landed. */
  readonly clear: (botId: string) => void;
  /** Withdraws every request: none of them is still asked for. */
  readonly clearAll: () => void;
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
  clearAll: () =>
    set((state) =>
      Object.keys(state.byBotId).length === 0 ? state : { byBotId: {} },
    ),
}));
