import { createContext } from "react";

/**
 * One of a bot's own sessions read as a chat, read-only (Tracy Bots T93):
 * what its send cards name and where their links take the reader. `null`
 * everywhere else, where a send card names no place and links nowhere.
 */
export interface BotSessionAccess {
  readonly botId: string;
  /** The host serving the tab: a thread's post is read through it. */
  readonly hostId: string;
  /**
   * The thread a thread's session answers in, and its post in the channel
   * (`null` while the thread list does not name it); `null` for the trunk,
   * which answers in the channel.
   */
  readonly thread: {
    readonly threadId: string;
    readonly post: {
      readonly conversationId: string;
      readonly messageId: string;
    } | null;
  } | null;
  /** Shows the bot's channel, on `messageId` where one is named. */
  readonly openChannel: (messageId: string | null) => void;
  /** Shows one of the bot's threads beside its channel, by the thread's id. */
  readonly openThread: (threadId: string) => void;
}

export const BotSessionContext = createContext<BotSessionAccess | null>(null);
