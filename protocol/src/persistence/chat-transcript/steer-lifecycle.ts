import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import {
  chatQueuedItemSchema,
  type ChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * A running fold over the chat's `queue.*` events.
 * Two implementations of a fold that must agree is precisely what `row-projection.ts`'s "consume, do not mirror" rule exists to prevent - the module records a predicate that shipped with a renderer-side copy disagreeing.
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
