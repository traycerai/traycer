import type {
  ChatQueuedItem,
  ChatQueuedManagedCommandItem,
  ChatQueuedPromptItem,
  ChatQueueState,
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
 * A pending delivery of a shell's output (a watcher's log digest, a
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

/**
 * Prompt ids the host still holds in the queue.
 *
 * While one of these ids is queued, that queue row is the prompt's only
 * visible copy. The optimistic chat row stays in session state and is not
 * drawn.
 */
export function queuedPromptMessageIds(
  items: ReadonlyArray<ChatQueuedItem>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === "prompt") ids.add(item.messageId);
  }
  return ids;
}

/**
 * The queue the message panel should draw once a prompt has reached the
 * transcript.
 *
 * Accepting a queued prompt persists the user message and then removes the
 * queue item. A frame can carry the persisted message while the item is still
 * listed, and drawing both shows the prompt twice at the handoff. The
 * transcript row is the copy from then on.
 *
 * Display only. Setup, pause, and cancel keep reading the session queue.
 */
export function queueWithoutPersistedPrompts(
  queue: ChatQueueState,
  messages: ReadonlyArray<{
    readonly role: string;
    readonly messageId: string;
  }>,
): ChatQueueState {
  if (queue.items.length === 0) return queue;
  const persistedUserMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") persistedUserMessageIds.add(message.messageId);
  }
  if (persistedUserMessageIds.size === 0) return queue;
  const items = queue.items.filter((item) => {
    if (item.kind !== "prompt") return true;
    return !persistedUserMessageIds.has(item.messageId);
  });
  if (items.length === queue.items.length) return queue;
  return { status: queue.status, items };
}
