import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import {
  chatQueuedItemSchema,
  type ChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * # Which user messages completed an interrupt-restart steer
 *
 * A running fold over the chat's `queue.*` events. A `queue.steerRequested`
 * carrying an `interrupt_restart` request badges the user message it names;
 * a later `queue.fallback` / `queue.resumed` / `queue.cancelled` /
 * `queue.steerAborted` can RETRACT that badge, either by naming the message or
 * the queue item directly, or by carrying a queue snapshot in which the item no
 * longer holds an active steer.
 *
 * ## Why this is shared code rather than the renderer's own
 *
 * The answer is derived from the event log AROUND a row, not from the row. A
 * windowed client hydrating an old interrupt-restart user row is served that
 * row's own records - `rowRecordIds` for a user row is its message and nothing
 * else - so it holds none of the `queue.*` lifecycle and re-derives "not
 * steered". The badge is then present during the live session and gone from
 * cold history, which is the shape of bug this whole area keeps paying for.
 *
 * The fix is to carry the ANSWER per row
 * ({@link TranscriptRowContext.completedSteer}), which means the host has to
 * run this fold. Serving the events instead is not the alternative it looks
 * like: a retraction can arrive arbitrarily later than the request, so "the
 * events this row needs" is not bounded by the row.
 *
 * And it MOVED here rather than being copied. Two implementations of a fold
 * that must agree is precisely what `row-projection.ts`'s "consume, do not
 * mirror" rule exists to prevent - the module records a predicate that shipped
 * with a renderer-side copy disagreeing on the empty string. The renderer
 * imports this one.
 */
export function steeredMessageIdsFromEvents(
  events: ReadonlyArray<ChatEvent>,
): ReadonlySet<string> {
  const steeredMessageIds = new Set<string>();
  const steerRequestMessageIdsByQueueItemId = new Map<string, string>();
  for (const event of events) {
    if (event.type === "queue.steerRequested") {
      if (
        event.messageId !== null &&
        event.queueItemId !== null &&
        isInterruptRestartSteerRequest(event)
      ) {
        steeredMessageIds.add(event.messageId);
        steerRequestMessageIdsByQueueItemId.set(
          event.queueItemId,
          event.messageId,
        );
      }
      continue;
    }

    if (
      event.type === "queue.fallback" ||
      event.type === "queue.resumed" ||
      event.type === "queue.cancelled" ||
      event.type === "queue.steerAborted"
    ) {
      if (event.messageId !== null) {
        steeredMessageIds.delete(event.messageId);
      }
      if (event.queueItemId !== null) {
        const messageId = steerRequestMessageIdsByQueueItemId.get(
          event.queueItemId,
        );
        if (messageId !== undefined) {
          steeredMessageIds.delete(messageId);
          steerRequestMessageIdsByQueueItemId.delete(event.queueItemId);
        }
      }
      for (const item of queueItemsFromEventMetadata(event.metadata)) {
        if (queueItemHasActiveInterruptRestartSteer(item)) {
          continue;
        }
        // Only prompt items map back to a rendered user message; a
        // managed-command item has no message to un-badge.
        if (item.kind === "prompt") {
          steeredMessageIds.delete(item.messageId);
        }
        steerRequestMessageIdsByQueueItemId.delete(item.queueItemId);
      }
    }
  }
  return steeredMessageIds;
}

function isInterruptRestartSteerRequest(event: ChatEvent): boolean {
  if (event.type !== "queue.steerRequested") return false;
  const requestedItems = queueItemsFromEventMetadata(event.metadata);
  for (const item of requestedItems) {
    if (item.queueItemId !== event.queueItemId) continue;
    // Managed-command items are never steered, so they never carry a request.
    if (item.kind !== "prompt") return false;
    return item.steerRequest?.mode === "interrupt_restart";
  }
  return false;
}

function queueItemHasActiveInterruptRestartSteer(
  item: ChatQueuedItem,
): boolean {
  if (item.kind !== "prompt") return false;
  return (
    (item.status === "steer_requested" || item.status === "steering") &&
    item.steerRequest !== null &&
    item.steerRequest.mode === "interrupt_restart"
  );
}

function queueItemsFromEventMetadata(
  metadata: ChatEvent["metadata"],
): ReadonlyArray<ChatQueuedItem> {
  if (metadata === null) return [];
  const stateItems = metadata["items"];
  if (Array.isArray(stateItems)) {
    return stateItems.flatMap((item) => {
      const parsed = chatQueuedItemSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }
  const parsed = chatQueuedItemSchema.safeParse(metadata["item"]);
  return parsed.success ? [parsed.data] : [];
}
