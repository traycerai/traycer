import type {
  ChatQueuedItem,
  ChatQueuedManagedCommandItem,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";

export type ReceivedAgentQueueItem = ChatQueuedPromptItem & {
  readonly sender: Extract<ChatQueuedPromptItem["sender"], { type: "agent" }>;
};

/**
 * A2A (agent-to-agent) responses ride the same chat queue plumbing as user
 * messages but are system-owned. They surface in the queue UI so the user can
 * see pending responses received from other agents and reorder them, but they
 * render read-only - reorder only, never edit / delete / hand-steer. This
 * guard is the single origin marker the queue UI gates per-row behavior on
 * (`"agent"` for A2A delivery, `"user"` for user-typed sends).
 *
 * Scoped to prompt items on purpose. Managed-command items are system-owned
 * too, but their policy keys on their own `kind` (see
 * `isManagedCommandQueueItem`), so relaxing an A2A gate later can never leak
 * onto them.
 */
export function isReceivedAgentResponse(
  item: ChatQueuedItem,
): item is ReceivedAgentQueueItem {
  return item.kind === "prompt" && item.sender.type === "agent";
}

/**
 * A pending delivery of a managed command's output (a Monitor's log digest, a
 * backgrounded shell's completion digest). Content-free: the chip renders from
 * `description`, and the host renders the digest itself from the command's log
 * at dispatch. The user may reorder or cancel it; it is never editable or
 * hand-steerable.
 */
export function isManagedCommandQueueItem(
  item: ChatQueuedItem,
): item is ChatQueuedManagedCommandItem {
  return item.kind === "managed-command";
}
