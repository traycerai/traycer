import type {
  ChatQueuedItem,
  ChatQueueState,
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
  item: Pick<ChatQueuedItem, "queueItemId">,
): boolean {
  return optimisticQueuedItemClientActionId(item.queueItemId) !== null;
}

export function appendOptimisticQueuedItem(
  queue: ChatQueueState,
  item: ChatQueuedItem,
): ChatQueueState {
  if (queueContainsQueuedSend(queue, item)) return queue;
  return {
    status: queueStatusWithOptimisticItems(queue.status, queue.status),
    items: [...queue.items, item],
  };
}

export function mergeQueueWithOptimisticQueuedItems(
  authoritativeQueue: ChatQueueState,
  currentQueue: ChatQueueState,
  retainedClientActionIds: ReadonlySet<string>,
): ChatQueueState {
  const retainedOptimisticItems = currentQueue.items.filter((item) =>
    shouldRetainOptimisticQueuedItem(
      item,
      authoritativeQueue,
      retainedClientActionIds,
    ),
  );
  if (retainedOptimisticItems.length === 0) return authoritativeQueue;
  return {
    status: queueStatusWithOptimisticItems(
      authoritativeQueue.status,
      currentQueue.status,
    ),
    items: [...authoritativeQueue.items, ...retainedOptimisticItems],
  };
}

export function removeOptimisticQueuedItemByClientActionId(
  queue: ChatQueueState,
  clientActionId: string,
): ChatQueueState {
  return withoutOptimisticQueuedItems(
    queue,
    (item) => item.queueItemId === optimisticQueuedItemId(clientActionId),
  );
}

export function removeOptimisticQueuedItemByMessageId(
  queue: ChatQueueState,
  messageId: string,
): ChatQueueState {
  return withoutOptimisticQueuedItems(
    queue,
    (item) => item.messageId === messageId,
  );
}

function shouldRetainOptimisticQueuedItem(
  item: ChatQueuedItem,
  authoritativeQueue: ChatQueueState,
  retainedClientActionIds: ReadonlySet<string>,
): boolean {
  const clientActionId = optimisticQueuedItemClientActionId(item.queueItemId);
  if (clientActionId === null) return false;
  if (!retainedClientActionIds.has(clientActionId)) return false;
  return !queueContainsQueuedSend(authoritativeQueue, item);
}

function queueStatusWithOptimisticItems(
  authoritativeStatus: ChatQueueState["status"],
  currentStatus: ChatQueueState["status"],
): ChatQueueState["status"] {
  if (authoritativeStatus === "paused" || currentStatus === "paused") {
    return "paused";
  }
  return "running";
}

function withoutOptimisticQueuedItems(
  queue: ChatQueueState,
  shouldRemove: (item: ChatQueuedItem) => boolean,
): ChatQueueState {
  const items = queue.items.filter(
    (item) => !isOptimisticQueuedItem(item) || !shouldRemove(item),
  );
  if (items.length === queue.items.length) return queue;
  return {
    status: items.length === 0 ? "idle" : queue.status,
    items,
  };
}

function queueContainsQueuedSend(
  queue: ChatQueueState,
  item: ChatQueuedItem,
): boolean {
  const content = JSON.stringify(item.message.content);
  const sender = JSON.stringify(item.sender);
  const settings = JSON.stringify(item.settings);
  return queue.items.some((candidate) => {
    if (candidate.queueItemId === item.queueItemId) return true;
    if (candidate.messageId === item.messageId) return true;
    if (JSON.stringify(candidate.message.content) !== content) return false;
    if (JSON.stringify(candidate.sender) !== sender) return false;
    return JSON.stringify(candidate.settings) === settings;
  });
}
