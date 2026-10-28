import { create } from "zustand";
import type { BotConversationSendDelivery } from "@traycer/protocol/host/bot/conversation-schemas";

/**
 * The thread open beside a bot's channel, by the message it hangs off: a
 * member's post, one of the bot's questions or proposals, or one of its
 * direct replies.
 */
export interface BotOpenThread {
  readonly anchorMessageId: string;
  /**
   * The thread opens with the first reply under its anchor, sent with the
   * anchor's id: the bot's question, proposal or direct reply, or a post the
   * bot answered in the channel (reply mode `direct`). `false` for a post's
   * own thread.
   */
  readonly announcement: boolean;
  /**
   * The anchor is the bot's direct reply, whose own thread only a bound host
   * that names it among its thread anchors opens: its box sends only while
   * the bot's binding does.
   */
  readonly answer: boolean;
  /**
   * The person's post that opened the thread as its send was accepted, which
   * the channel knows before the thread list or the channel's own row does.
   * `null` for a thread opened from a row.
   */
  readonly sent: BotSentPost | null;
}

/** A post as its send was accepted: what the panel draws until the channel's row and the thread list catch up. */
export interface BotSentPost {
  readonly threadId: string;
  readonly requestId: string;
  readonly text: string;
  /** The person who sent it; `null` when nobody was signed in. */
  readonly senderUserId: string | null;
  /** When the send was accepted. */
  readonly sentAt: number;
  /** `queued`: it waits for the bot's host, and the panel says so under it. */
  readonly delivery: BotConversationSendDelivery;
}

interface BotOpenThreadState {
  readonly byBotId: Readonly<Record<string, BotOpenThread>>;
  readonly setOpenThread: (botId: string, open: BotOpenThread | null) => void;
}

/**
 * Which thread each bot tab has open, held above the tab's views so the
 * thread survives a switch between the channel's tabs (an announcement's
 * thread nobody has started yet still opens as the box that starts it).
 * Closing the tab drops its entry (`closeBotTab`). Not persisted: a restart
 * opens the channel with no thread.
 */
export const useBotOpenThreadStore = create<BotOpenThreadState>()((set) => ({
  byBotId: {},
  setOpenThread: (botId, open) =>
    set((state) => {
      const next = { ...state.byBotId };
      if (open === null) delete next[botId];
      else next[botId] = open;
      return { byBotId: next };
    }),
}));

/** The thread open in `botId`'s tab, or `null`. */
export function useBotOpenThread(botId: string): BotOpenThread | null {
  return useBotOpenThreadStore((state) =>
    Object.hasOwn(state.byBotId, botId) ? state.byBotId[botId] : null,
  );
}
