import { createContext } from "react";
import type { BotSendReceipt } from "@traycer/protocol/persistence/epic/content-blocks";
import type { BotSendNames } from "@/lib/bots/bot-send-tool";

/**
 * One of a bot's own sessions read as a chat, read-only:
 * what its send cards name and where their links take the reader. `null`
 * everywhere else, where a send card names no place and links nowhere.
 */
export interface BotSessionAccess extends BotSendNames {
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
  /**
   * Shows one of the bot's threads beside its channel, by the thread's id,
   * landed on `messageId` of it where one is named.
   */
  readonly openThread: (threadId: string, messageId: string | null) => void;
  /**
   * What a question's card says of each question (T94), read from the post
   * as the channel has loaded it now, for Find; `null` while it has not.
   */
  readonly questionStatesOf: (
    receipt: BotSendReceipt,
  ) => ReadonlyArray<string | null> | null;
  /**
   * Calls `onChange` whenever what `questionStatesOf` reads in one of
   * `conversationIds` may have changed: a session there opening or closing,
   * or the messages it holds changing. Returns the unsubscribe.
   */
  readonly watchQuestionStates: (
    conversationIds: readonly string[],
    onChange: () => void,
  ) => () => void;
}

export const BotSessionContext = createContext<BotSessionAccess | null>(null);
