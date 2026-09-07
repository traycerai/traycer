/** Which host owns which chat ids on one surface. */
export interface ChatIndicatorHostScope {
  readonly hostId: string;
  /** The chat (and terminal-agent) ids this host owns on this surface. */
  readonly chatIds: ReadonlyArray<string>;
}

/** The scopes for a set of tabs, one per distinct host, ids de-duplicated. */
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
