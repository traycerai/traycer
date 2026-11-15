import {
  plainTextJsonContent,
  withImageParagraph,
} from "@traycer/protocol/common/plain-text-content";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import {
  botSendRequestId,
  botThreadIdFor,
  conversationRequestMessageId,
} from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { holdPendingSend } from "@/stores/bots/bot-pending-sends-store";

/** A send drawn at Send: the ids its stored row will have, derived from its nonce. */
export interface BotPendingSendStart {
  /** The request to send, its nonce included. */
  readonly request: BotConversationSendRequest;
  readonly requestId: string;
  /** The stored row's id, which the pending row is drawn under. */
  readonly messageId: string;
  /**
   * The thread the send opens, where it opens one: a post's own, should the
   * bot answer it in a thread, or the thread under the row an announcement's
   * first reply answers.
   */
  readonly threadId: string | null;
  readonly text: string;
  readonly content: JsonContent;
  readonly senderUserId: string;
  readonly sentAt: number;
}

/**
 * Mints `request`'s nonce, derives the id the host will store its row under
 * (Tracy Bots T249), and holds the row, drawn at once in the chat it lands
 * in: the thread's for a reply, the one an announcement's first reply opens,
 * else the channel's. The row's document is the one the host stores: the
 * trimmed text, then the images in a paragraph of their own, here the box's
 * own nodes, whose bytes the host does not hold yet. `release` lets go of
 * what the box's draft held for the send, once the host has it.
 */
export function startPendingSend(input: {
  readonly request: BotConversationSendRequest;
  /** The host serving the tab, which takes the send. */
  readonly hostId: string;
  /** Who is signed in: the host derives the id from its authenticated caller. */
  readonly senderUserId: string;
  /** What the box sent: its text, and its document, which a thread opened at Send draws. */
  readonly text: string;
  readonly content: JsonContent;
  /** The `imageAttachment` nodes of the images the send carries, in order. */
  readonly images: ReadonlyArray<JsonContent>;
  readonly release: () => void;
}): BotPendingSendStart {
  const { hostId, senderUserId, text, content } = input;
  const nonce = crypto.randomUUID();
  const request: BotConversationSendRequest = {
    ...input.request,
    sendNonce: nonce,
  };
  const threadId = request.threadId ?? null;
  const announcementId = request.announcementId ?? null;
  const requestId = botSendRequestId({
    botId: request.botId,
    conversationId: request.conversationId,
    threadId,
    announcementId,
    senderUserId,
    nonce,
  });
  const messageId = conversationRequestMessageId(requestId);
  const sentAt = Date.now();
  const answered =
    announcementId === null
      ? null
      : botThreadIdFor(request.botId, announcementId);
  // A reply's row lands in its thread, an announcement's first reply's in
  // the thread it opens, a post's in the channel.
  const chatId = threadId ?? answered ?? request.conversationId;
  const opens =
    threadId !== null
      ? null
      : (answered ?? botThreadIdFor(request.botId, messageId));
  const row: Message = {
    role: "user",
    messageId,
    sender: { type: "user", userId: senderUserId },
    message: {
      kind: "user",
      content: withImageParagraph(
        plainTextJsonContent(request.text.trim()),
        input.images,
      ),
      browserAnnotations: [],
    },
    timestamp: sentAt,
    sessionAnchor: null,
    conversationRequest: {
      requestId,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
  holdPendingSend({
    botId: request.botId,
    chatId,
    hostId,
    row,
    request,
    release: input.release,
  });
  return {
    request,
    requestId,
    messageId,
    threadId: opens,
    text,
    content,
    senderUserId,
    sentAt,
  };
}
