import { create } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
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
  /** The sent document, including images, until the channel row arrives. */
  readonly content?: JsonContent;
  /** The person who sent it; `null` when nobody was signed in. */
  readonly senderUserId: string | null;
  /** When the send was accepted. */
  readonly sentAt: number;
  /** `queued`: it waits for the bot's host, and the panel says so under it. */
  readonly delivery: BotConversationSendDelivery;
}

/**
 * One of the bot's own sessions to open as a read-only chat in place of its
 * channel: the trunk's (`threadId` `null`) or a thread's,
 * and the message of it the view lands on (`null`: where it opens).
 * `sendPostId` is a post the session's send wrote (T94): the view lands on
 * that send's card where the session has one, else on `messageId`.
 */
export interface BotSessionTarget {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly sendPostId: string | null;
}

/** Opens one of the bot's sessions, read-only, in place of its channel. */
export type BotSessionOpen = (target: BotSessionTarget) => void;

/**
 * Opens a turn of the bot: its session, landed on the message that started
 * the turn, or on the card of the send that wrote `sendPostId` (`null` for
 * none).
 */
export type BotTurnOpen = (ref: BotTurnRef, sendPostId: string | null) => void;

/** Where a turn of the bot is in its session, and the post of it to land on. */
export function sessionTargetOfTurn(
  ref: BotTurnRef,
  sendPostId: string | null,
): BotSessionTarget {
  return {
    chatId: ref.chatId,
    threadId: ref.threadId,
    messageId: ref.userMessageId,
    sendPostId,
  };
}

/**
 * What the bot knows, open in the rail: read-only, and the
 * thread it displaced, which its back button restores (`null` when it
 * displaced none).
 */
export interface BotOpenMemory {
  readonly back: BotOpenThread | null;
}

/**
 * The log of the bot's messages with another bot, open in the rail
 * (decision 174): read-only, and what it displaced, which closing it brings
 * back (`null` when it displaced nothing).
 */
export interface BotOpenExchange {
  readonly peerBotId: string;
  readonly back: BotRail | null;
}

/** Opens a pair's log in the rail, and closes it back to what it displaced. */
export interface BotExchangeRail {
  readonly open: (peerBotId: string) => void;
  readonly close: () => void;
}

/**
 * What a search holds the rail for: its results, a thread one of them opened
 * in their place, or nothing while a pane too narrow for both shows the
 * channel at a result. The last two offer the way back to the results.
 */
export type BotSearchShowing =
  | { readonly kind: "results" }
  | { readonly kind: "thread"; readonly thread: BotOpenThread }
  | { readonly kind: "channel" };

/**
 * A search open in the rail, and what it displaced, which closing the results
 * restores (`null` when it displaced nothing).
 */
export interface BotOpenSearch {
  readonly back: BotRail | null;
  readonly showing: BotSearchShowing;
}

/**
 * What the rail beside a bot's channel holds: one slot, a thread, the bot's
 * memory, a pair's log or a search, the newer replacing the older.
 */
export type BotRail =
  | ({ readonly kind: "thread" } & BotOpenThread)
  | ({ readonly kind: "memory" } & BotOpenMemory)
  | ({ readonly kind: "exchange" } & BotOpenExchange)
  | ({ readonly kind: "search" } & BotOpenSearch);

/**
 * The memory opened over what the rail holds (the bot's profile card): it
 * takes the one slot and keeps for its back button the thread it displaces,
 * or the one the memory, a pair's log or a search already there displaced.
 */
export function memoryRailOver(rail: BotRail | null): BotRail {
  if (rail === null) return { kind: "memory", back: null };
  if (rail.kind === "thread") return { kind: "memory", back: threadOf(rail) };
  if (rail.kind === "memory") return { kind: "memory", back: rail.back };
  if (rail.kind === "search" && rail.showing.kind === "thread") {
    return { kind: "memory", back: rail.showing.thread };
  }
  return memoryRailOver(rail.back);
}

/**
 * A pair's log opened over what the rail holds: it takes the one slot and
 * keeps what it displaces for its close, or what the log already open there
 * displaced, so another pair replaces the log and closing still returns to
 * the rail as it was before the first.
 */
export function exchangeRailOver(
  rail: BotRail | null,
  peerBotId: string,
): BotRail {
  const back = rail?.kind === "exchange" ? rail.back : rail;
  return { kind: "exchange", peerBotId, back };
}

/**
 * Search results opened over what the rail holds: they take the one slot and
 * keep for closing what they displace, or what the search already open there
 * displaced.
 */
export function searchRailOver(rail: BotRail | null): BotRail {
  return {
    kind: "search",
    back: withoutSearch(rail),
    showing: { kind: "results" },
  };
}

/** `rail` past any search in it: a new search takes the place of an older one. */
function withoutSearch(rail: BotRail | null): BotRail | null {
  if (rail?.kind === "search") return withoutSearch(rail.back);
  if (rail?.kind === "exchange") {
    return { ...rail, back: withoutSearch(rail.back) };
  }
  return rail;
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
 * started yet still opens as the box that starts it). Closing the surface
 * drops its entry. Not persisted: after a restart the rail is what the
 * surface's route names for the channel (`useTracyPlaceRoute`), and nothing
 * where it names none.
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
