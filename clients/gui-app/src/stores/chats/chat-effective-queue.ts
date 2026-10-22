import type {
  OpenChatQueuedPromptItem,
  OpenChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { drainingQueuePrompt } from "@/lib/chat/draining-queue-item";

type QueueHandoffState = Pick<ChatSessionState, "queue" | "drainingQueueItems">;

export function hasDrainingQueueItems(
  state: Pick<ChatSessionState, "drainingQueueItems">,
): boolean {
  return (state.drainingQueueItems?.length ?? 0) > 0;
}

const effectiveQueueCache = new WeakMap<
  OpenChatQueueState,
  WeakMap<ReadonlyArray<OpenChatQueuedPromptItem>, OpenChatQueueState>
>();

/**
 * Display and resource ownership continue through the queue-to-turn handoff.
 * Mutations and host confirmations must still read the authoritative queue.
 */
export function queueWithDrainingPrompts(
  state: QueueHandoffState,
): OpenChatQueueState {
  const held = state.drainingQueueItems;
  if (held === undefined || held.length === 0) return state.queue;
  let byHeld = effectiveQueueCache.get(state.queue);
  if (byHeld === undefined) {
    byHeld = new WeakMap();
    effectiveQueueCache.set(state.queue, byHeld);
  }
  const cached = byHeld.get(held);
  if (cached !== undefined) return cached;
  const queue = {
    ...state.queue,
    items: [...held.map(drainingQueuePrompt), ...state.queue.items],
  };
  byHeld.set(held, queue);
  return queue;
}
