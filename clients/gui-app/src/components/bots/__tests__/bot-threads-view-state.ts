/**
 * What the threads-view files' mocked boundaries read: the answers the host
 * gives each bot, the listed bots, the sessions, the unread counts, the
 * callbacks the view calls and whether the pane the view is in is on screen.
 * It imports no app module at run time, so a mock
 * factory can reach it while the app's modules are still loading. The harness
 * resets it for every case.
 */
import { vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  BotThreadAnchors,
  BotThreadSummary,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  BotNotificationLevel,
  BotReadCursorReadResponse,
  BotRecord,
  BotThreadFollow,
  BotThreadFollowSetRequest,
} from "@traycer/protocol/host/bot/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/** What the host answers for one bot. */
export type BotScript = {
  threads: BotThreadSummary[];
  /** The rows the bot's bound host says it opens a thread under; `null` for a host that says none. */
  threadAnchors: BotThreadAnchors | null;
  follows: Record<string, BotThreadFollow>;
  cursors: BotReadCursorReadResponse;
  levels: Record<string, BotNotificationLevel>;
};

export const mocks = {
  /** The host's answers by bot id. */
  hosted: {} as Record<string, BotScript>,
  /** The listed bots, in the column's order. */
  bots: [] as BotRecord[],
  /** Methods the host does not advertise. */
  unsupported: new Set<string>(),
  /** Each bot channel's posts by message id. */
  posts: {} as Record<string, Record<string, string>>,
  /** Each bot channel's session, where a case scripts its rows in full. */
  channels: {} as Record<string, ChatSessionStoreHandle>,
  /** Each thread's reply texts by thread id, in order; its session holds them. */
  replies: {} as Record<string, string[]>,
  /** A thread's rows by thread id, where a case scripts them in full. */
  replyRows: {} as Record<string, Message[]>,
  /** The turns `bot.turn.locate` knows. */
  turns: [] as BotTurnRef[],
  threadSessions: {} as Record<string, ChatSessionStoreHandle>,
  advances: [] as unknown[],
  /** The next advance the host is asked for is refused, as one to an offline host is. */
  failNextAdvance: false,
  /** Unread notifications by thread id, as the indicators read them. */
  unread: {} as Record<string, number>,
  writes: [] as BotThreadFollowSetRequest[],
  /** Every read the host answered: its method and the params it was sent. */
  reads: [] as Array<{ method: string; params: unknown }>,
  client: null as HostClient<HostRpcRegistry> | null,
  activateTabIntent: vi.fn<(intent: unknown) => void>(),
  /** How `bot.list` stands: answered, still being read, or failed. */
  botList: "listed" as "listed" | "pending" | "failed",
  refetchBots: vi.fn<() => Promise<unknown>>(),
  back: vi.fn<() => void>(),
};

/** Whether the pane the view is in is on screen, and who is told when that changes. */
export const pane = { visible: true, listeners: new Set<() => void>() };
