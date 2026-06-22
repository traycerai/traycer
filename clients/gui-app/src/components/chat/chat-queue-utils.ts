import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

export type ReceivedAgentQueueItem = ChatQueuedItem & {
  readonly sender: Extract<ChatQueuedItem["sender"], { type: "agent" }>;
};

/**
 * A2A (agent-to-agent) responses ride the same chat queue plumbing as user
 * messages but are system-owned. They surface in the queue UI so the user can
 * see pending responses received from other agents and reorder them, but they
 * render read-only - reorder only, never edit / delete / hand-steer. This
 * guard is the single origin marker the queue UI gates per-row behavior on
 * (`"agent"` for A2A delivery, `"user"` for user-typed sends).
 */
export function isReceivedAgentResponse(
  item: ChatQueuedItem,
): item is ReceivedAgentQueueItem {
  return item.sender.type === "agent";
}
