import { createContext } from "react";

/**
 * The thread a channel post opened (Tracy Bots), as the line under the post
 * shows it: how many replies, when the last one landed, and whether it has
 * a reply the viewer has not read.
 */
export interface ChatBotThreadLine {
  readonly replyCount: number;
  readonly lastReplyAt: number | null;
  readonly unread: boolean;
}

/**
 * How a bot's channel or thread draws its rows (Tracy Bots, decision 41):
 * Slack's message layout - a picture, the sender's name and the time, then
 * the text - for members' messages and the bot's own rows alike, with the
 * state of the request each member's message opened under it.
 *
 * A bot surface provides it; every other transcript leaves it `null` and
 * draws its rows as it always has, the bot's trunk and thread sessions
 * included (their transcripts are the under-the-hood view, not a channel).
 */
export interface ChatBotPresentation {
  /** The bot's name on its rows: the current title, so a rename shows at once. */
  readonly botTitle: string;
  /**
   * Lands the list on the reply that resolved a request, by its message id;
   * `null` where the reply is not in this list (a channel post's verdict is
   * in its thread, reached through the thread line).
   */
  readonly scrollToMessage: ((messageId: string) => void) | null;
  /**
   * The thread line under a channel post, by the post's message id; `null`
   * in a thread, where messages open no thread, and for a post whose thread
   * is not listed yet.
   */
  readonly threadLine:
    | ((postMessageId: string) => ChatBotThreadLine | null)
    | null;
  /** Opens the thread of a channel post; `null` in a thread. */
  readonly openThread: ((postMessageId: string) => void) | null;
  /**
   * Opens the thread under a question or proposal, by the announcement's
   * message id: its thread when it has one, else a box whose first reply
   * opens it. `null` in a thread.
   */
  readonly openAnnouncementThread: ((announcementId: string) => void) | null;
  /**
   * Posts one of a bot reply's options as the person's next message in the
   * thread; `null` in the channel.
   */
  readonly chooseOption: ((choice: string) => void) | null;
}

export const ChatBotPresentationContext =
  createContext<ChatBotPresentation | null>(null);
