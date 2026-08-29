import { chatTranscriptEventRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { TranscriptRowLocator } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { ChatTranscriptJumpTarget } from "@/stores/chats/chat-transcript-jump-store";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/**
 * Where a cross-tile jump LANDS, and who is able to say.
 *
 * Split out of `chat-tile.tsx` rather than exported from it: the tile is a
 * component module, so anything else it exports breaks fast refresh (and the
 * lint rule that guards it). These are pure decisions over a jump target, a
 * window and the rendered models, which is also what makes them testable
 * without the 100 KB tile behind them.
 *
 * The two questions are deliberately separate. {@link hostLocatorForJumpTarget}
 * decides whether to ASK the host, and answering `null` there means "this
 * client can place the row itself" - a request sent anyway is a round trip
 * whose answer is discarded. {@link coldJumpOrdinal} decides where the row IS,
 * and reads the host's answer only where its own reads have nothing.
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
 * Resolve a durable protocol message id to the row id used by the rendered
 * transcript. User rows keep their protocol id, while assistant records are
 * projected into turn-keyed rows (`assistant:<turnId>`) and retain the
 * protocol id only as `persistentMessageId`. Terminal notifications point at
 * that durable id, so an id-only lookup silently waits forever for a row that
 * can never exist.
 *
 * Prefer an exact rendered id. When projection split one assistant turn into
 * several rows, choose the trailing matching slice: completion and failure
 * notifications describe the terminal edge of that persisted assistant
 * record, and the completion marker is stamped on the final assistant slice
 * in the current transcript projection.
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
 * Resolves a `sent-message` transcript jump: the message holding this chat's
 * own "Sent message" card for one A2A exchange. Matched on receiver + the
 * VERBATIM text because those are the only identifiers the send block and the
 * comm-event row durably share - the sender's block id never reaches the
 * host's capture (origin refs are receiver-side). When the same text went to
 * the same receiver more than once, the send whose start time is nearest the
 * event's capture time wins; both clocks are the same host's.
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
 * The ordinal a cold jump target sits at. `null` means "nothing to ask for":
 * the legacy line, or a host-locatable target whose answer has not landed.
 *
 * Module scope rather than a closure over `hostLocatedOrdinal`, which is why
 * that value is a parameter. A function declared in the render body is a new
 * identity every render, so the effect that calls it would have to carry it as
 * a dependency and would re-run on every frame - on the hot path this is
 * deliberately not on.
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
    // A message id is a row id for a USER record only. An assistant record is
    // projected into turn-keyed rows and keeps its durable id off the skeleton
    // entirely, so the skeleton read misses and the host is the only answer -
    // and it is asked only when this read has already missed, so the fallback
    // costs a cold user row nothing.
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
    // Ordinal 0 of the WHOLE transcript. The skeleton is whole-chat, so its
    // first entry names the real first row rather than the top of the
    // hydrated tail.
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
 * The locator to ask the host for, or `null` when this client can place the row
 * itself.
 *
 * The gate is "every read this client has has already missed", never "this kind
 * usually needs the host" - a request sent while the answer is derivable is a
 * round trip whose result is discarded, and on the windowed line that is the
 * common case for two of the three kinds.
 *
 * Scoped to the windowed line: with `transcriptWindow === null` the client
 * holds the whole transcript, so an unmatched anchor genuinely is absent and
 * there is nothing for the host to find that the client has not already looked
 * at.
 *
 * Module scope for the same reason {@link coldJumpOrdinal} is, and so the
 * decision can be tested without the tile.
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
    // BOTH client reads have to miss before the host is worth asking, and they
    // miss for different reasons. The skeleton read covers a cold USER row,
    // whose row id IS its message id - the common case, and one no round trip
    // should be spent on. The rendered read covers a HYDRATED assistant row,
    // which carries the durable id as `persistentMessageId`. What is left over
    // is exactly the case the host exists for here: an assistant record whose
    // turn-keyed rows are cold.
    const placeable =
      skeletonOrdinalOf(transcriptWindow, target.messageId) !== null ||
      messageIdForTranscriptTarget(messages, target.messageId) !== null;
    return placeable ? null : { kind: "message", messageId: target.messageId };
  }
  return null;
}
