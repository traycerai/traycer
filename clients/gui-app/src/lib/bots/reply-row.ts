import type { BotThreadAnchor } from "@traycer/protocol/host/bot/conversation-schemas";
import type { ConversationRequest } from "@traycer/protocol/persistence/epic/messages";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";
import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * The rendered row that carries a persisted message (Tracy Bots).
 *
 * A landing names a MESSAGE id, but the transcript scrolls by RENDERED ROW
 * key, and an assistant row's key is not its message id: a row with no turn
 * is keyed `assistant:ts:<timestamp>`, and a multi-record turn renders as
 * one row carrying every record's id in `turnMessageIds` with the last
 * record's id as `persistentMessageId`. So the jump resolves the message to
 * the row that renders it, and only then asks the list to land there. `null`
 * when no rendered row carries it - the message is outside the hydrated
 * window and has to be located and loaded first.
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
 * The card of the send that wrote the post `postId` (Tracy Bots T94): the
 * rendered row that carries its tool call, and the call's block, by the post
 * its `botSendReceipt` names. `null` when no rendered row carries it.
 */
export function sendCardFor(
  messages: ReadonlyArray<ChatMessage>,
  postId: string,
): { readonly rowId: string; readonly blockId: string } | null {
  for (const message of messages) {
    for (const segment of message.segments) {
      if (
        segment.kind === "tool" &&
        segment.botSendReceipt?.messageId === postId
      ) {
        return { rowId: message.id, blockId: segment.id };
      }
    }
  }
  return null;
}

/**
 * The text of a channel row - a member's post or one of the bot's own rows
 * - as the chat's store holds it (Tracy Bots T65): a thread names the post
 * it answers by id only, and wherever a thread shows its post, the text is
 * read from the channel. `null` when the store has not loaded that row.
 */
export function postTextOf(post: OpenMessage | null): string | null {
  if (post === null) return null;
  if (post.role === "user") {
    return extractPlainTextFromComposerJSONContent(post.message.content);
  }
  return post.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/**
 * The post a thread opens on, as the channel's row draws it. `loaded` once
 * it is read from the channel's own row, the authoritative post that Retry
 * and Edit act on. Before that the row stands in for it: the post as the
 * person sent it (its text, writer, time and request), or what the thread
 * list says of it (its writer, its time and its request, no text), and
 * nothing can send it again.
 */
export interface ThreadOriginRow {
  readonly row: ChatMessage;
  readonly loaded: boolean;
}

/**
 * The post a thread opens on (Tracy Bots, decision 90): from the channel's
 * row once it is loaded, else from the post as the person sent it (a send
 * the host queued has no row until the bot's host takes it), else from the
 * thread list's anchor. A member's post carries its request, so a post the
 * bot failed to answer says so here as in the channel; the bot's own
 * question or proposal carries its announcement. `null` while none is known.
 */
export function threadOriginRow(input: {
  /** The post's message id. */
  readonly messageId: string;
  readonly post: OpenMessage | null;
  readonly sent: BotSentPost | null;
  readonly anchor: BotThreadAnchor | null;
  /** The writer's name, as the channel shows it; `null` for a sender that is no member. */
  readonly senderLabel: (senderUserId: string | null) => string;
  readonly senderAvatarUrl: (senderUserId: string) => string | null;
}): ThreadOriginRow | null {
  const { post, sent, anchor, senderLabel, senderAvatarUrl } = input;
  if (post !== null) {
    return { row: loadedOriginRow(post, input), loaded: true };
  }
  if (sent !== null) {
    const row = memberOriginRow(
      originRowBase(input.messageId, "user", sent.sentAt, sent.text),
      sent.senderUserId,
      {
        requestId: sent.requestId,
        resolvedAt: null,
        resolvedByMessageId: null,
      },
      { senderLabel, senderAvatarUrl },
    );
    return { row, loaded: false };
  }
  if (anchor === null) return null;
  const base = originRowBase(
    anchor.messageId,
    anchor.senderUserId === null ? "assistant" : "user",
    anchor.sentAt,
    "",
  );
  if (anchor.senderUserId === null) return { row: base, loaded: false };
  const row = memberOriginRow(
    base,
    anchor.senderUserId,
    {
      requestId: anchor.requestId,
      resolvedAt: anchor.resolvedAt,
      resolvedByMessageId: null,
    },
    { senderLabel, senderAvatarUrl },
  );
  return { row, loaded: false };
}

function loadedOriginRow(
  post: OpenMessage,
  names: {
    readonly senderLabel: (senderUserId: string | null) => string;
    readonly senderAvatarUrl: (senderUserId: string) => string | null;
  },
): ChatMessage {
  const text = postTextOf(post) ?? "";
  if (post.role === "assistant") {
    return {
      ...originRowBase(post.messageId, "assistant", post.timestamp, text),
      ...(post.announcement === undefined
        ? {}
        : { announcement: post.announcement }),
      // A question's thread opens on its card, settled as the channel shows it.
      ...(post.question === undefined ? {} : { question: post.question }),
      // A surface post's thread opens on its card, resolved as the channel shows it.
      ...(post.surface === undefined ? {} : { surface: post.surface }),
    };
  }
  const userId = post.sender.type === "user" ? post.sender.userId : null;
  return memberOriginRow(
    originRowBase(post.messageId, "user", post.timestamp, text),
    userId,
    post.conversationRequest ?? null,
    names,
  );
}

function memberOriginRow(
  base: ChatMessage,
  userId: string | null,
  request: ConversationRequest | null,
  names: {
    readonly senderLabel: (senderUserId: string | null) => string;
    readonly senderAvatarUrl: (senderUserId: string) => string | null;
  },
): ChatMessage {
  const avatarUrl = userId === null ? null : names.senderAvatarUrl(userId);
  return {
    ...base,
    senderLabel: names.senderLabel(userId),
    ...(userId === null ? {} : { senderUserId: userId }),
    ...(avatarUrl === null ? {} : { senderAvatarUrl: avatarUrl }),
    ...(request === null ? {} : { conversationRequest: request }),
  };
}

function originRowBase(
  messageId: string,
  role: "user" | "assistant",
  sentAt: number,
  text: string,
): ChatMessage {
  return {
    id: messageId,
    role,
    content: text,
    segments:
      text.length > 0
        ? [
            {
              id: `${messageId}:text`,
              kind: "text",
              markdown: text,
              isStreaming: false,
            },
          ]
        : [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: sentAt,
    completedAt: null,
    stopped: null,
    persistentMessageId: messageId,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}
