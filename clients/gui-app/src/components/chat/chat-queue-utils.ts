import type {
  ChatQueuedItem,
  ChatQueuedManagedCommandItem,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";

export type ReceivedAgentQueueItem = ChatQueuedPromptItem & {
  readonly sender: Extract<ChatQueuedPromptItem["sender"], { type: "agent" }>;
};

/** They surface in the queue UI so the user can see pending responses received from other agents and reorder them, but they render read-only - reorder only, never edit / delete / hand-steer. Managed-command items are system-owned too, but their policy keys on their own `kind` (see `isManagedCommandQueueItem`), so relaxing an A2A gate later can never leak onto them. */
export function isReceivedAgentResponse(
  item: ChatQueuedItem,
): item is ReceivedAgentQueueItem {
  return item.kind === "prompt" && item.sender.type === "agent";
}

/** The user may reorder or cancel it; it is never editable or hand-steerable. */
export function isManagedCommandQueueItem(
  item: ChatQueuedItem,
): item is ChatQueuedManagedCommandItem {
  return item.kind === "managed-command";
}
