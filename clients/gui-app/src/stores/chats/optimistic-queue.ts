import type {
  OpenChatQueuedItem,
  OpenChatQueuedPromptItem,
  OpenChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";

const OPTIMISTIC_QUEUED_ITEM_ID_PREFIX = "optimistic-send:";

export function optimisticQueuedItemId(clientActionId: string): string {
  return `${OPTIMISTIC_QUEUED_ITEM_ID_PREFIX}${clientActionId}`;
}

export function optimisticQueuedItemClientActionId(
  queueItemId: string,
): string | null {
  if (!queueItemId.startsWith(OPTIMISTIC_QUEUED_ITEM_ID_PREFIX)) return null;
  return queueItemId.slice(OPTIMISTIC_QUEUED_ITEM_ID_PREFIX.length);
}

export function isOptimisticQueuedItem(
  item: Pick<OpenChatQueuedItem, "queueItemId">,
): boolean {
  return optimisticQueuedItemClientActionId(item.queueItemId) !== null;
}

export function appendOptimisticQueuedItem(
  queue: OpenChatQueueState,
  item: OpenChatQueuedPromptItem,
): OpenChatQueueState {
  if (queueContainsQueuedSend(queue, item)) return queue;
  return queueWithStatus(
    queue,
    queueStatusWithOptimisticItems(queue.status, queue.status),
    [...queue.items, item],
  );
}

export function mergeQueueWithOptimisticQueuedItems(
  authoritativeQueue: OpenChatQueueState,
  currentQueue: OpenChatQueueState,
  retainedClientActionIds: ReadonlySet<string>,
): OpenChatQueueState {
  const retainedOptimisticItems = currentQueue.items.filter((item) =>
    shouldRetainOptimisticQueuedItem(
      item,
      authoritativeQueue,
      retainedClientActionIds,
    ),
  );
  if (retainedOptimisticItems.length === 0) return authoritativeQueue;
  return queueWithStatus(
    authoritativeQueue,
    queueStatusWithOptimisticItems(
      authoritativeQueue.status,
      currentQueue.status,
    ),
    [...authoritativeQueue.items, ...retainedOptimisticItems],
  );
}

export function removeOptimisticQueuedItemByClientActionId(
  queue: OpenChatQueueState,
  clientActionId: string,
): OpenChatQueueState {
  return withoutOptimisticQueuedItems(
    queue,
    (item) => item.queueItemId === optimisticQueuedItemId(clientActionId),
  );
}

export function removeOptimisticQueuedItemByMessageId(
  queue: OpenChatQueueState,
  messageId: string,
): OpenChatQueueState {
  return withoutOptimisticQueuedItems(
    queue,
    (item) => item.kind === "prompt" && item.messageId === messageId,
  );
}

function shouldRetainOptimisticQueuedItem(
  item: OpenChatQueuedItem,
  authoritativeQueue: OpenChatQueueState,
  retainedClientActionIds: ReadonlySet<string>,
): boolean {
  // Only an optimistic user send can be retained across a snapshot swap; the
  // host is the sole author of managed-command items, so there is never a
  // local one to hold onto.
  if (item.kind !== "prompt") return false;
  const clientActionId = optimisticQueuedItemClientActionId(item.queueItemId);
  if (clientActionId === null) return false;
  if (!retainedClientActionIds.has(clientActionId)) return false;
  return !queueContainsQueuedSend(authoritativeQueue, item);
}

function queueStatusWithOptimisticItems(
  authoritativeStatus: OpenChatQueueState["status"],
  currentStatus: OpenChatQueueState["status"],
): OpenChatQueueState["status"] {
  if (authoritativeStatus === "paused" || currentStatus === "paused") {
    return "paused";
  }
  return "running";
}

function withoutOptimisticQueuedItems(
  queue: OpenChatQueueState,
  shouldRemove: (item: OpenChatQueuedItem) => boolean,
): OpenChatQueueState {
  const items = queue.items.filter(
    (item) => !isOptimisticQueuedItem(item) || !shouldRemove(item),
  );
  if (items.length === queue.items.length) return queue;
  return queueWithStatus(
    queue,
    items.length === 0 ? "idle" : queue.status,
    items,
  );
}

/**
 * The queue rebuilt with a status and items of its own.
 *
 * It SPREADS the queue it starts from: the host's queue grows optional keys
 * (`pausedReason`, `chat.subscribe@1.18`), and a copy that names its fields
 * drops each new one without the compiler noticing. But `pausedReason` is the
 * reason a PAUSED queue is paused, so a rebuild that lands on any other status
 * clears it - a spread alone would carry a paused queue's reason onto the idle
 * or running queue it became, and the pill would say "Paused after an error"
 * about a queue that is not paused. A queue that never carried the key (an
 * older host) is left without one.
 */
function queueWithStatus(
  queue: OpenChatQueueState,
  status: OpenChatQueueState["status"],
  items: OpenChatQueueState["items"],
): OpenChatQueueState {
  const next: OpenChatQueueState = { ...queue, status, items };
  if (status === "paused" || (queue.pausedReason ?? null) === null) return next;
  return { ...next, pausedReason: null };
}

function queueContainsQueuedSend(
  queue: OpenChatQueueState,
  item: OpenChatQueuedPromptItem,
): boolean {
  const content = JSON.stringify(item.message.content);
  const sender = JSON.stringify(item.sender);
  const settings = JSON.stringify(item.settings);
  return queue.items.some((candidate) => {
    if (candidate.queueItemId === item.queueItemId) return true;
    // A managed-command item carries no message/sender/settings, so it can
    // never be the host's echo of this send.
    if (candidate.kind !== "prompt") return false;
    if (candidate.messageId === item.messageId) return true;
    if (JSON.stringify(candidate.message.content) !== content) return false;
    if (JSON.stringify(candidate.sender) !== sender) return false;
    return JSON.stringify(candidate.settings) === settings;
  });
}
