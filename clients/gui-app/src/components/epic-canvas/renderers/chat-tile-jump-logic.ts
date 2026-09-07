import { chatTranscriptEventRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { TranscriptRowLocator } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { ChatTranscriptJumpTarget } from "@/stores/chats/chat-transcript-jump-store";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/**
 * Split out of `chat-tile.tsx` rather than exported from it: the tile is a component module, so anything else it exports breaks fast refresh (and the lint rule that guards it).
 * These are pure decisions over a jump target, a window and the rendered models, which is also what makes them testable without the 100 KB tile behind them.
 */

type BackgroundBlockSearchNode =
  | MessageSegment
  | {
      readonly id: string;
      readonly children: ReadonlyArray<BackgroundBlockSearchNode>;
    }
  | {
      readonly id: string;
      readonly files: ReadonlyArray<BackgroundBlockSearchNode>;
    }
  | {
      readonly id: string;
      readonly segments: ReadonlyArray<BackgroundBlockSearchNode>;
    }
  | {
      readonly id: string;
      readonly group: {
        readonly segments: ReadonlyArray<BackgroundBlockSearchNode>;
      };
    };

function segmentContainsBackgroundBlock(
  segment: BackgroundBlockSearchNode,
  blockId: string,
): boolean {
  if (segment.id === blockId) return true;
  return backgroundBlockSearchChildren(segment).some((child) =>
    segmentContainsBackgroundBlock(child, blockId),
  );
}

function backgroundBlockSearchChildren(
  segment: BackgroundBlockSearchNode,
): ReadonlyArray<BackgroundBlockSearchNode> {
  if ("children" in segment) return segment.children;
  if ("files" in segment) return segment.files;
  if ("segments" in segment) return segment.segments;
  if ("group" in segment) return segment.group.segments;
  return [];
}

export function messageIdForBlock(
  messages: ReadonlyArray<ChatMessageModel>,
  blockId: string,
): string | null {
  const owner = messages.find((message) =>
    message.segments.some((segment) =>
      segmentContainsBackgroundBlock(segment, blockId),
    ),
  );
  return owner?.id ?? null;
}

/**
 * User rows keep their protocol id, while assistant records are projected into turn-keyed rows (`assistant:<turnId>`) and retain the protocol id only as `persistentMessageId`.
 * Terminal notifications point at that durable id, so an id-only lookup silently waits forever for a row that can never exist.
 */
export function messageIdForTranscriptTarget(
  messages: ReadonlyArray<ChatMessageModel>,
  messageId: string,
): string | null {
  const exact = messages.find((message) => message.id === messageId);
  if (exact !== undefined) return exact.id;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.persistentMessageId === messageId) return message.id;
  }
  return null;
}

/**
 * Matched on receiver + the VERBATIM text because those are the only identifiers the send block and the comm-event row durably share - the sender's block id never reaches the host's capture (origin refs are receiver-side).
 */
export function sentMessageAnchorId(
  messages: ReadonlyArray<ChatMessageModel>,
  target: {
    readonly receiverAgentId: string;
    readonly messageText: string;
    readonly timestamp: number;
  },
): string | null {
  const candidates: Array<{
    readonly messageId: string;
    readonly distance: number;
  }> = [];
  const visit = (messageId: string, node: BackgroundBlockSearchNode): void => {
    if (
      "kind" in node &&
      node.kind === "tool" &&
      node.agentMessageSend !== null &&
      node.agentMessageSend.receiverAgentId === target.receiverAgentId &&
      node.agentMessageSend.message === target.messageText
    ) {
      candidates.push({
        messageId,
        distance: Math.abs(node.startedAt - target.timestamp),
      });
    }
    for (const child of backgroundBlockSearchChildren(node)) {
      visit(messageId, child);
    }
  };
  for (const message of messages) {
    for (const segment of message.segments) {
      visit(message.id, segment);
    }
  }
  let best: { readonly messageId: string; readonly distance: number } | null =
    null;
  for (const candidate of candidates) {
    if (best === null || candidate.distance < best.distance) best = candidate;
  }
  return best?.messageId ?? null;
}

/**
 * Module scope rather than a closure over `hostLocatedOrdinal`, which is why that value is a parameter.
 */
export function coldJumpOrdinal(
  transcriptWindow: TranscriptWindow | null,
  target: ChatTranscriptJumpTarget,
  hostLocatedOrdinal: number | null,
): number | null {
  if (transcriptWindow === null) return null;
  switch (target.kind) {
    // The two whose row id needs rendered models, which a cold row has none of.
    case "block":
    case "sent-message":
      return hostLocatedOrdinal;
    // An assistant record is projected into turn-keyed rows and keeps its durable id off the skeleton entirely, so the skeleton read misses and the host is the only answer - and it is asked only when this read has already missed, so the fallback costs a cold user row nothing.
    case "message":
      return (
        skeletonOrdinalOf(transcriptWindow, target.messageId) ??
        hostLocatedOrdinal
      );
    case "event":
      return skeletonOrdinalOf(
        transcriptWindow,
        chatTranscriptEventRowId(target.eventId),
      );
    // The skeleton is whole-chat, so its first entry names the real first row rather than the top of the hydrated tail.
    case "first-message":
      return transcriptWindow.skeleton[0] === undefined ? null : 0;
    case "end":
      return null;
  }
}

function skeletonOrdinalOf(
  transcriptWindow: TranscriptWindow,
  rowId: string,
): number | null {
  const ordinal = transcriptWindow.skeleton.findIndex(
    (entry) => entry !== undefined && entry.rowId === rowId,
  );
  return ordinal < 0 ? null : ordinal;
}

/**
 * Module scope for the same reason {@link coldJumpOrdinal} is, and so the decision can be tested without the tile.
 */
export function hostLocatorForJumpTarget(input: {
  readonly target: ChatTranscriptJumpTarget;
  readonly transcriptWindow: TranscriptWindow | null;
  readonly messages: ReadonlyArray<ChatMessageModel>;
}): TranscriptRowLocator | null {
  const { messages, target, transcriptWindow } = input;
  if (transcriptWindow === null) return null;
  if (target.kind === "block") {
    return messageIdForBlock(messages, target.blockId) === null
      ? { kind: "block", blockId: target.blockId }
      : null;
  }
  if (target.kind === "sent-message") {
    return sentMessageAnchorId(messages, target) === null
      ? {
          kind: "sent-message",
          receiverAgentId: target.receiverAgentId,
          messageText: target.messageText,
          timestamp: target.timestamp,
        }
      : null;
  }
  if (target.kind === "message") {
    // BOTH client reads have to miss before the host is worth asking, and they miss for different reasons.
    const placeable =
      skeletonOrdinalOf(transcriptWindow, target.messageId) !== null ||
      messageIdForTranscriptTarget(messages, target.messageId) !== null;
    return placeable ? null : { kind: "message", messageId: target.messageId };
  }
  return null;
}
