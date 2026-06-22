import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

export function queueItemSteerLocked(item: ChatQueuedItem): boolean {
  return item.status === "steer_requested" || item.status === "steering";
}
