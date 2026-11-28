/**
 * THE SINGLE PLACE the T249 tests learn how a bot send's identity is made and
 * how the host's "I wrote nothing" refusal is shaped. If the plan changes
 * either (the derivation, the request field, the error marker), this file is
 * the only one that changes; the suites ask these functions, never the wire.
 *
 * Today: the request carries `sendNonce` and the `authority` it was made
 * for; its request id is `botSendRequestId({ botId, conversationId, threadId,
 * announcementId, senderUserId, authority, nonce })`; the stored row is `conversationRequestMessageId` of
 * it; a definite refusal is a `HostRpcError` with `notWritten: true`.
 */
import {
  HostRpcError,
  HostTransportFailureError,
  transportFailureBeforeSend,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  plainTextJsonContent,
  withImageParagraph,
} from "@traycer/protocol/common/plain-text-content";
import type {
  BotConversationSendRequest,
  BotSendAuthority,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  botSendRequestId,
  conversationRequestMessageId,
} from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";

/** The row the host stores for a send: one shape both the persisted and the wire message take. */
type StoredUserRow = Extract<Message, { role: "user" }> &
  Extract<OpenMessage, { role: "user" }>;

const SEND_METHOD = "bot.conversation.send";

/** The send identifier a request carries; a request without one is a test failure. */
export function sendNonceOf(request: BotConversationSendRequest): string {
  if (request.sendNonce === undefined) {
    throw new Error("the send carries no sendNonce");
  }
  return request.sendNonce;
}

/** The binding a nonce request names; a request without one is a test failure. */
export function authorityOfSend(
  request: BotConversationSendRequest,
): BotSendAuthority {
  if (request.authority === undefined) {
    throw new Error("the send carries no authority");
  }
  return request.authority;
}

/** The request id the host (and the pending row) derive for `request` from `senderUserId`. */
export function requestIdOfSend(
  request: BotConversationSendRequest,
  senderUserId: string,
): string {
  return botSendRequestId({
    botId: request.botId,
    conversationId: request.conversationId,
    threadId: request.threadId ?? null,
    announcementId: request.announcementId ?? null,
    senderUserId,
    authority: authorityOfSend(request),
    nonce: sendNonceOf(request),
  });
}

/** The id of the row the host stores for `request`. */
export function storedMessageIdOfSend(
  request: BotConversationSendRequest,
  senderUserId: string,
): string {
  return conversationRequestMessageId(requestIdOfSend(request, senderUserId));
}

/** The document the host stores for `request`: its trimmed text as the host maps it, then its images in a paragraph of their own. */
function documentOfSend(request: BotConversationSendRequest): JsonContent {
  const images = (request.attachments ?? []).map((attachment, index) => ({
    type: "imageAttachment",
    attrs: {
      id: `attachment-${String(index)}`,
      fileName: attachment.fileName,
      mimeType: attachment.mediaType,
      b64content: attachment.b64content,
    },
  }));
  return withImageParagraph(plainTextJsonContent(request.text.trim()), images);
}

/** The row the host stores for `request`, as a transcript snapshot carries it. */
export function storedRowOfSend(
  request: BotConversationSendRequest,
  senderUserId: string,
  timestamp: number,
): StoredUserRow {
  const requestId = requestIdOfSend(request, senderUserId);
  return {
    role: "user",
    messageId: conversationRequestMessageId(requestId),
    sender: { type: "user", userId: senderUserId },
    message: {
      kind: "user",
      content: documentOfSend(request),
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
    conversationRequest: {
      requestId,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

/** What the host answers a send that was accepted. */
export function sendReceipt(
  request: BotConversationSendRequest,
  senderUserId: string,
  threadId: string | null,
): {
  messageId: string;
  requestId: string;
  delivery: "written";
  threadId: string | null;
} {
  const requestId = requestIdOfSend(request, senderUserId);
  return {
    messageId: conversationRequestMessageId(requestId),
    requestId,
    delivery: "written",
    threadId,
  };
}

/** The host refused before writing anything, and said so. */
export function notWrittenRefusal(message: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId: "request-refused",
    method: SEND_METHOD,
    fatalDetails: null,
    notWritten: true,
  });
}

/**
 * The host refused the send before writing it: the bot is no longer bound
 * where the request was sent, at the epoch it named (`authority`).
 */
export function authorityMovedRefusal(message: string): HostRpcError {
  return new HostRpcError({
    code: "E_BOT_AUTHORITY_MOVED",
    message,
    requestId: "request-moved",
    method: SEND_METHOD,
    fatalDetails: null,
    notWritten: true,
  });
}

/** The host answered an error that does not say it wrote nothing. */
export function unmarkedRefusal(message: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId: "request-answered",
    method: SEND_METHOD,
    fatalDetails: null,
  });
}

/** The request never left the client. */
export function neverLeft(message: string): HostTransportFailureError {
  return transportFailureBeforeSend({
    message,
    requestId: "request-never-left",
    method: SEND_METHOD,
  });
}

/** The link dropped after the request was dispatched: it may have been written. */
export function lostAfterDispatch(message: string): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message,
    requestId: "request-lost",
    method: SEND_METHOD,
    fatalDetails: null,
  });
}
