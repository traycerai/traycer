import { createContext } from "react";
import type { StackedIdentity } from "@/components/bots/bot-avatars";

/**
 * The thread a channel post opened (Tracy Bots), as the line under the post
 * shows it: how many replies, when the last one landed, whether it has a
 * reply the viewer has not read and how many, whether the bot is answering in
 * it now, and who is in it: the post's writer, and the bot once it has a reply.
 */
export interface ChatBotThreadLine {
  readonly participants: ReadonlyArray<StackedIdentity>;
  readonly replyCount: number;
  readonly lastReplyAt: number | null;
  readonly unread: boolean;
  /** The viewer's unread notifications of the thread; `null` where the host does not count, and the line draws a dot. */
  readonly unreadCount: number | null;
  readonly replying: boolean;
}

/**
 * A message the bot failed to answer, or whose answer is held: why, and what
 * a member can do about it: send it to the bot again as it is, on their own
 * message put its text back in the box to edit and send as a new message
 * that replaces it, and sign in where that is the fix.
 */
export interface ChatBotFailedRequest {
  /** `failed`: the answer errored; `parked`: it is held and has not started. */
  readonly state: "failed" | "parked";
  /** Why, in the words the agent chat's error row uses; `null` when the host gave no reason. */
  readonly summary: string | null;
  /** Opens the provider's sign-in on the bot's host; `null` unless signing in is the fix. */
  readonly signIn: (() => void) | null;
  /**
   * Sends it again; `text` is the message's own. `null` where it cannot be
   * sent again: a host that cannot re-deliver, or a message whose text is not
   * loaded yet.
   */
  readonly retry: ((text: string) => void) | null;
  /** `true` while a retry of it is being sent. */
  readonly retrying: boolean;
  /**
   * Puts `text`, the message's own, in the box that replaces it; `null` on
   * a teammate's message, which only its writer can replace, and wherever
   * Retry is `null`.
   */
  readonly edit: ((text: string) => void) | null;
}

/**
 * How a bot's channel or thread draws its rows (Tracy Bots, decision 41):
 * Slack's message layout - a picture, the sender's name and the time, then
 * the text - for members' messages and the bot's own rows alike, with a
 * jump to the reply that answered a member's message where that reply is
 * not right under it, and Slack's message actions on hover. The request
 * state itself (open or answered) is the bot's bookkeeping and is not drawn.
 *
 * A bot surface provides it; every other transcript leaves it `null` and
 * draws its rows as it always has, the bot's trunk and thread sessions
 * included (their transcripts are the under-the-hood view, not a channel).
 */
export interface ChatBotPresentation {
  /** The bot's name on its rows: the current title, so a rename shows at once. */
  readonly botTitle: string;
  /**
   * Lands the list on a message by its id: the reply that resolved a
   * request. In the channel only a direct post's reply is in the list; a
   * thread post's verdict is in its thread, reached through the thread line.
   */
  readonly scrollToMessage: ((messageId: string) => void) | null;
  /**
   * Whether a reply renders right after the post it answers, by their
   * message ids, so the jump to it is not offered; `null` where nothing can
   * tell.
   */
  readonly replyFollowsPost:
    | ((postMessageId: string, replyMessageId: string) => boolean)
    | null;
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
   * Opens the thread under a question, a proposal, a direct post or, where
   * `answer`, the bot's direct reply, by the row's message id: its thread
   * when it has one, else a box whose first reply opens it. `null` in a
   * thread.
   */
  readonly openAnnouncementThread:
    | ((announcementId: string, answer: boolean) => void)
    | null;
  /**
   * Whether the bot's host opens a thread under a direct reply of the bot
   * (decision 114), so the reply opens its own thread and carries its line;
   * `false` where it does not say, and a direct reply then opens the thread
   * under the post it answers.
   */
  readonly answerThreads: boolean;
  /**
   * Posts one of a bot reply's options as the person's next message: in the
   * thread, or a new post in the channel for a direct reply's; `null` where
   * nothing can post it.
   */
  readonly chooseOption: ((choice: string) => void) | null;
  /**
   * A member's message the bot failed to answer, by its request id and its
   * writer: why, and its actions, while the session that failed or parked on
   * it still holds it; `null` for any other request.
   */
  readonly failedRequest:
    | ((
        requestId: string,
        senderUserId: string | null,
      ) => ChatBotFailedRequest | null)
    | null;
}

export const ChatBotPresentationContext =
  createContext<ChatBotPresentation | null>(null);
