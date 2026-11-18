import type {
  BrowserCatalogIdentity,
  BrowserCatalogRecord,
} from "@traycer/protocol/host/browser/catalog-contracts";

/**
 * Tabs this window closed, per viewer and task. The owner acks a close before
 * its catalog push lands, so a read in between still lists the tab; filtering
 * every later read keeps the row from coming back. Hosts mint tab ids as fresh
 * UUIDs, so a closed id is never listed again legitimately.
 */
const closedTabsByScope = new Map<string, Set<string>>();

function scopeKey(userId: string, epicId: string): string {
  return JSON.stringify([userId, epicId]);
}

function tabKey(hostId: string, sessionId: string, tabId: string): string {
  return JSON.stringify([hostId, sessionId, tabId]);
}

export function noteClosedBrowserCatalogTab(
  userId: string,
  identity: BrowserCatalogIdentity,
  tabId: string,
): void {
  const key = scopeKey(userId, identity.epicId);
  const closed = closedTabsByScope.get(key) ?? new Set<string>();
  closed.add(tabKey(identity.hostId, identity.sessionId, tabId));
  closedTabsByScope.set(key, closed);
}

export function withoutClosedBrowserCatalogTabs(
  userId: string,
  epicId: string,
  records: readonly BrowserCatalogRecord[],
): readonly BrowserCatalogRecord[] {
  const closed = closedTabsByScope.get(scopeKey(userId, epicId));
  if (closed === undefined) return records;
  return records.flatMap((record) => {
    const tabs = record.tabs.filter(
      (tab) => !closed.has(tabKey(record.hostId, record.sessionId, tab.tabId)),
    );
    if (tabs.length === record.tabs.length) return [record];
    return tabs.length === 0 ? [] : [{ ...record, tabs }];
  });
}
