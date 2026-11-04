import {
  epicCommunicationGraphEventSchema,
  type EpicCommunicationGraphEvent,
} from "@traycer/protocol/host/epic/communication-graph";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";

export const BOT_ID = "bot_01JC0000000000000000000000";
export const RELEASE_BOT_ID = "bot_01JC0000000000000000000001";
export const DOCS_BOT_ID = "bot_01JC0000000000000000000002";
export const TRUNK_CHAT_ID = "trunk-tracy";
export const THREAD_SESSION_ID = "session-thread-1";
export const FEED_HOST_ID = "host-1";

/** The origin fields of a feed row. */
export interface FeedOrigin {
  readonly originKind: EpicCommunicationGraphEvent["originKind"];
  readonly originChatId: string | null;
  readonly originRefId: string | null;
}

/** The sending task's mirror of a message: the host writes it with no origin. */
export const SENT_MIRROR: FeedOrigin = {
  originKind: null,
  originChatId: null,
  originRefId: null,
};

/**
 * The receiving task's row, promoted from the delivery: the receiving session
 * is its origin chat, and a receipt key its ref.
 */
export function receivedBy(receiver: string, receipt: string): FeedOrigin {
  return {
    originKind: "gui_message",
    originChatId: receiver,
    originRefId: receipt,
  };
}

interface WireEventInput {
  readonly id: number;
  readonly kind: EpicCommunicationGraphEvent["kind"];
  readonly timestamp: number;
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly text: string | null;
  readonly responseId: string | null;
  readonly inReplyTo: string | null;
  readonly peerEpicId: string | null;
  readonly origin: FeedOrigin;
}

/**
 * A feed row as the host's `epic.communicationGraph.subscribe` stream sends
 * it: parsed through the protocol's event schema, so the fixture is the real
 * wire shape, with the host the row came from added.
 */
export function feedEvent(input: WireEventInput): CommGraphEvent {
  const event = epicCommunicationGraphEventSchema.parse({
    id: input.id,
    kind: input.kind,
    timestamp: input.timestamp,
    senderAgentId: input.sender,
    receiverAgentId: input.receiver,
    responseId: input.responseId,
    inReplyTo: input.inReplyTo,
    expectReply: input.inReplyTo === null,
    messageText: input.text,
    noticeReason: input.kind === "a2a_notice" ? "turn-ended" : null,
    originKind: input.origin.originKind,
    originChatId: input.origin.originChatId,
    originRefId: input.origin.originRefId,
    peerEpicId: input.peerEpicId,
  });
  return { ...event, hostId: FEED_HOST_ID };
}
