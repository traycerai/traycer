import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * The rendered row that carries a persisted message (Tracy Bots).
 *
 * A user row's `conversationRequest.resolvedByMessageId` names the REPLY'S
 * MESSAGE id, but the transcript scrolls by RENDERED ROW key, and an
 * assistant row's key is not its message id: a row with no turn is keyed
 * `assistant:ts:<timestamp>`, and a multi-record turn renders as one row
 * carrying every record's id in `turnMessageIds` with the last record's id
 * as `persistentMessageId`. So the jump resolves the message to the row that
 * renders it, and only then asks the list to land there. `null` when no
 * rendered row carries it - the reply is outside the hydrated window and
 * has to be located and loaded first.
 */
export function replyRowIdFor(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): string | null {
  for (const message of messages) {
    if (message.persistentMessageId === messageId) return message.id;
    if (message.turnMessageIds?.includes(messageId) === true) return message.id;
  }
  return null;
}

/**
 * Whether the reply `replyMessageId` renders in the row right after the post
 * `postMessageId`, where the reader sees the answer without a jump. `false`
 * when either is not in the rendered rows.
 */
export function replyFollowsPost(
  messages: ReadonlyArray<ChatMessage>,
  postMessageId: string,
  replyMessageId: string,
): boolean {
  const postIndex = messages.findIndex(
    (message) => message.persistentMessageId === postMessageId,
  );
  if (postIndex === -1) return false;
  const next = messages.at(postIndex + 1);
  if (next === undefined) return false;
  return (
    next.persistentMessageId === replyMessageId ||
    next.turnMessageIds?.includes(replyMessageId) === true
  );
}

/** A post as the line above a direct reply names it. */
export interface ChatBotRepliedPost {
  readonly senderLabel: string;
  /** The post's first line, cut. */
  readonly excerpt: string;
}

/** Characters of a post's first line the line above a direct reply shows. */
const REPLIED_POST_EXCERPT_MAX = 80;

/**
 * The post a bot's direct reply answers, as the reply's line names it (Tracy
 * Bots, reply mode `direct`): its sender and its first line. `null` when no
 * rendered row carries it.
 */
export function repliedPostOf(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): ChatBotRepliedPost | null {
  const post = messages.find(
    (message) =>
      message.role === "user" && message.persistentMessageId === messageId,
  );
  if (post === undefined) return null;
  const text = rowText(post);
  const firstLine =
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  return {
    senderLabel: post.senderLabel ?? "Member",
    excerpt:
      firstLine.length > REPLIED_POST_EXCERPT_MAX
        ? `${firstLine.slice(0, REPLIED_POST_EXCERPT_MAX - 1)}…`
        : firstLine,
  };
}

/**
 * The text of the channel row `messageId` - a member's post or one of the
 * bot's own rows - as the chat's store holds it (Tracy Bots T65): a thread
 * names the post it answers by id only, and wherever a thread shows its
 * post, the text is read from the channel. `null` when the store has not
 * loaded that row.
 */
export function postTextOf(
  messages: ReadonlyArray<OpenMessage>,
  messageId: string,
): string | null {
  const post = messages.find((message) => message.messageId === messageId);
  if (post === undefined) return null;
  if (post.role === "user") {
    return extractPlainTextFromComposerJSONContent(post.message.content);
  }
  return post.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function rowText(message: ChatMessage): string {
  return message.segments
    .flatMap((segment) => (segment.kind === "text" ? [segment.markdown] : []))
    .join("\n");
}
