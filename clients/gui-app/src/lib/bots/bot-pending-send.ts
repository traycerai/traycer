import {
  plainTextJsonContent,
  withImageParagraph,
} from "@traycer/protocol/common/plain-text-content";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BotConversationSendRequest,
  BotSendAuthority,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  botSendRequestId,
  botThreadIdFor,
  conversationRequestMessageId,
} from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { holdPendingSend } from "@/stores/bots/bot-pending-sends-store";
import type { BotSentAs } from "@/lib/bots/bot-sent-as";

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
  /**
   * Who it went out as: what its answer opens or settles is written in its
   * bot lifetime only.
   */
  readonly sentAs: BotSentAs;
}

/**
 * The bot's binding as a surface reads it now, which a member's send from it
 * is made for and offered again under: a send carries a nonce, and is drawn,
 * only through the tab's host while that host is the bot's bound host; a held
 * send is offered again only through the host it was made for, at the epoch
 * it was made for or a newer one.
 */
export interface BotSendBinding {
  /** The host serving the tab, through which a send and its retries go. */
  readonly hostId: string;
  /** The host that runs the bot; `null` when none does. */
  readonly boundHostId: string | null;
  /** The bot's epoch on that host. */
  readonly boundHostEpoch: number;
  /** Reads the bot again, once a host refused a send because the binding moved. */
  readonly onMoved: () => void;
}

/**
 * Mints `request`'s nonce, names the binding it is made for (`authority`),
 * derives the id the host will store its row under from both (Tracy Bots
 * T249), and holds the row, drawn at once in the chat it lands
 * in: the thread's for a reply, the one an announcement's first reply opens,
 * else the channel's. The row's document is the one the host stores: the
 * trimmed text, then the images in a paragraph of their own, here the box's
 * own nodes, whose bytes the host does not hold yet. `release` lets go of
 * what the box's draft held for the send, once the host has it.
 */
export function startPendingSend(input: {
  readonly request: BotConversationSendRequest;
  /**
   * The binding the send is made for: the bot's bound host, which serves the
   * tab and takes the send, at its epoch. It rides the request, and the host
   * refuses the send, nothing written, once it is not the bot's binding.
   */
  readonly authority: BotSendAuthority;
  /** Who is signed in: the host derives the id from its authenticated caller. */
  readonly senderUserId: string;
  /** Who the send goes out as, fixed at the press. */
  readonly sentAs: BotSentAs;
  /** What the box sent: its text, and its document, which a thread opened at Send draws. */
  readonly text: string;
  readonly content: JsonContent;
  /** The `imageAttachment` nodes of the images the send carries, in order. */
  readonly images: ReadonlyArray<JsonContent>;
  readonly release: () => void;
}): BotPendingSendStart {
  const { authority, senderUserId, text, content, sentAs } = input;
  const nonce = crypto.randomUUID();
  const request: BotConversationSendRequest = {
    ...input.request,
    sendNonce: nonce,
    authority,
  };
  const threadId = request.threadId ?? null;
  const announcementId = request.announcementId ?? null;
  const requestId = botSendRequestId({
    botId: request.botId,
    conversationId: request.conversationId,
    threadId,
    announcementId,
    senderUserId,
    authority,
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
    row,
    request,
    sentAs,
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
    sentAs,
  };
}
