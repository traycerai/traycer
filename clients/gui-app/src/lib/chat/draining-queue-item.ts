import type {
  OpenChatQueuedItem,
  OpenChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";

// A renderer-only fact: the host item stays unchanged, and this marker cannot
// travel on the wire. Object spreads preserve it through dock projections.
const DRAINING_QUEUE_ITEM = Symbol("drainingQueueItem");
type DrainingQueuePrompt = OpenChatQueuedPromptItem & {
  readonly [DRAINING_QUEUE_ITEM]: true;
};

export function drainingQueuePrompt(
  item: OpenChatQueuedPromptItem,
): DrainingQueuePrompt {
  return { ...item, [DRAINING_QUEUE_ITEM]: true };
}

export function isDrainingQueueItem(item: OpenChatQueuedItem): boolean {
  return DRAINING_QUEUE_ITEM in item;
}
