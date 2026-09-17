import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Pure predicates over a queue row, shared by the queue header (what to
 * offer) and by accepted-action settlement (what the host's pause / resume
 * leaves behind). Kept out of both the component and the store layers so
 * neither depends on the other for a fact about the row.
 */

export function queueItemSteerLocked(item: ChatQueuedItem): boolean {
  return item.status === "steer_requested" || item.status === "steering";
}

/**
 * Whether the header's Pause button would hold this row - the client mirror
 * of the host's `queueItemCanPauseForUser`. The button holds the user's own
 * backlog: a managed-command digest is system-owned, so it is not a "human
 * queued message" the button speaks for - it rides the queue's pause state,
 * but never justifies offering the button.
 */
export function queueItemCanPauseFromQueueHeader(
  item: ChatQueuedItem,
): boolean {
  if (item.kind !== "prompt") return false;
  if (item.sender.type !== "user") return false;
  if (item.status === "paused") return false;
  if (item.status === "steering" || item.status === "injected") return false;
  if (
    item.status === "steer_requested" &&
    item.steerRequest?.mode !== "safe_point"
  ) {
    return false;
  }
  return true;
}
