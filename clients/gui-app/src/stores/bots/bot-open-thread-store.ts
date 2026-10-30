import { create } from "zustand";
import type {
  BotConversationSendDelivery,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";

/**
 * The thread open beside a bot's channel, by the message it hangs off: a
 * member's post, or one of the bot's own rows.
 */
export interface BotOpenThread {
  readonly anchorMessageId: string;
  /**
   * The thread opens with the first reply under its anchor, sent with the
   * anchor's id: one of the bot's rows, or a post the bot answered in the
   * channel (reply mode `direct`). `false` for a post's own thread.
   */
  readonly announcement: boolean;
  /**
   * The thread anchor (`threadAnchors.kinds`) a bound host must name to
   * open a thread under the anchor: `"answer"` for the bot's direct reply,
   * `"message"` for any other row of the bot that is no question or
   * proposal. Its box sends only while the bot's binding names it. `null`
   * for a row every host takes a reply under.
   */
  readonly anchorKind: string | null;
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

/**
 * One of the bot's own sessions to open as a read-only chat in place of its
 * channel (Tracy Bots T93): the trunk's (`threadId` `null`) or a thread's,
 * and the message of it the view lands on (`null`: where it opens).
 */
export interface BotSessionTarget {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
}

/** Opens one of the bot's sessions, read-only, in place of its channel. */
export type BotSessionOpen = (target: BotSessionTarget) => void;

/** Opens a turn of the bot: its session, landed on the message that started the turn. */
export type BotTurnOpen = (ref: BotTurnRef) => void;

/** Where a turn of the bot is in its session. */
export function sessionTargetOfTurn(ref: BotTurnRef): BotSessionTarget {
  return {
    chatId: ref.chatId,
    threadId: ref.threadId,
    messageId: ref.userMessageId,
  };
}

/**
 * What the bot knows, open in the rail (Tracy Bots T87): read-only, and the
 * thread it displaced, which its back button restores (`null` when it
 * displaced none).
 */
export interface BotOpenMemory {
  readonly back: BotOpenThread | null;
}

/**
 * What the rail beside a bot's channel holds: one slot, a thread or the
 * bot's memory, the newer replacing the older.
 */
export type BotRail =
  | ({ readonly kind: "thread" } & BotOpenThread)
  | ({ readonly kind: "memory" } & BotOpenMemory);

/**
 * The memory opened over what the rail holds (the bot's profile card): it
 * takes the one slot and keeps for its back button the thread it displaces,
 * or the one the memory already open there displaced.
 */
export function memoryRailOver(rail: BotRail | null): BotRail {
  if (rail === null) return { kind: "memory", back: null };
  if (rail.kind === "thread") return { kind: "memory", back: threadOf(rail) };
  return { kind: "memory", back: rail.back };
}

function threadOf(
  rail: { readonly kind: "thread" } & BotOpenThread,
): BotOpenThread {
  const { kind: _kind, ...thread } = rail;
  return thread;
}

interface BotOpenThreadState {
  readonly byBotId: Readonly<Record<string, BotRail>>;
  readonly setRail: (botId: string, rail: BotRail | null) => void;
}

/**
 * What each bot tab's rail holds, held above the tab's views so it survives
 * a switch between the channel's tabs (an announcement's thread nobody has
 * started yet still opens as the box that starts it). Closing the tab drops
 * its entry (`closeBotTab`). Not persisted: a restart opens the channel with
 * nothing beside it.
 */
export const useBotOpenThreadStore = create<BotOpenThreadState>()((set) => ({
  byBotId: {},
  setRail: (botId, rail) =>
    set((state) => {
      const next = { ...state.byBotId };
      if (rail === null) delete next[botId];
      else next[botId] = rail;
      return { byBotId: next };
    }),
}));

/** What `botId`'s tab has in its rail, or `null`. */
export function useBotRail(botId: string): BotRail | null {
  return useBotOpenThreadStore((state) =>
    Object.hasOwn(state.byBotId, botId) ? state.byBotId[botId] : null,
  );
}
