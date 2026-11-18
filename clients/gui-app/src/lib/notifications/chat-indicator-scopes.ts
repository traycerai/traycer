/**
 * Which host owns which chat ids on one surface.
 *
 * Lives beside the notification feed-mode helpers rather than in the component
 * that consumes it: `ChatIndicatorHostScopes` exports components only, and a
 * module that exports both breaks fast refresh for every consumer of it.
 */
export interface ChatIndicatorHostScope {
  readonly hostId: string;
  /** The chat (and terminal-agent) ids this host owns on this surface. */
  readonly chatIds: ReadonlyArray<string>;
}

/**
 * The scopes for a set of tabs, one per distinct host, ids de-duplicated.
 *
 * Sorted by host id and by chat id so a re-render that only reorders tabs
 * produces the same scopes - the fan-out's depth and each layer's request would
 * otherwise churn on a drag.
 */
export function chatIndicatorHostScopes(
  entries: ReadonlyArray<{ readonly hostId: string; readonly chatId: string }>,
): ReadonlyArray<ChatIndicatorHostScope> {
  const byHost = new Map<string, Set<string>>();
  for (const entry of entries) {
    const existing = byHost.get(entry.hostId);
    if (existing === undefined) {
      byHost.set(entry.hostId, new Set([entry.chatId]));
      continue;
    }
    existing.add(entry.chatId);
  }
  return [...byHost.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostId, chatIds]) => ({
      hostId,
      chatIds: [...chatIds].sort((left, right) => left.localeCompare(right)),
    }));
}
