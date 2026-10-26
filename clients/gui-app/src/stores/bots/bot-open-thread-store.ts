import { create } from "zustand";

/**
 * The thread open beside a bot's channel, by the message it hangs off: a
 * member's post, or one of the bot's questions or proposals.
 */
export interface BotOpenThread {
  readonly anchorMessageId: string;
  /**
   * The thread opens with the first reply under its anchor, sent with the
   * anchor's id: the bot's question or proposal, or a post the bot answered
   * in the channel (reply mode `direct`). `false` for a post's own thread.
   */
  readonly announcement: boolean;
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
