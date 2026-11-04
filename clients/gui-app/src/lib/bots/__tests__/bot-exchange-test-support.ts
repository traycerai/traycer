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
    originKind: "gui_block",
    originChatId: input.sender,
    originRefId: null,
    peerEpicId: input.peerEpicId,
  });
  return { ...event, hostId: FEED_HOST_ID };
}
