import { useMemo, useState } from "react";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import {
  disambiguateSecondaryLabels,
  nextSettledTabIdentity,
  type SettledTabIdentity,
} from "@/lib/browser-view/browser-tab-display";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";

export interface BrowserSidebarTabRow {
  readonly key: string;
  readonly session: BrowserSessionInfo;
  readonly tab: BrowserTabInfo;
  readonly identity: SettledTabIdentity;
}

function nextBrowserSidebarTabRows(
  previous: readonly BrowserSidebarTabRow[],
  sessions: readonly BrowserSessionInfo[],
): readonly BrowserSidebarTabRow[] {
  const previousByKey = new Map(previous.map((row) => [row.key, row]));
  const next = sessions.flatMap((session) =>
    session.tabs.map((tab) => {
      const key = compositeKey(session.hostId, session.sessionId, tab.tabId);
      return {
        key,
        session,
        tab,
        identity: nextSettledTabIdentity(
          previousByKey.get(key)?.identity ?? null,
          tab,
        ),
      };
    }),
  );
  const nextByKey = new Map(next.map((row) => [row.key, row]));
  return [
    ...previous.flatMap((row) => {
      const current = nextByKey.get(row.key);
      return current === undefined ? [] : [current];
    }),
    ...next.filter((row) => !previousByKey.has(row.key)),
  ];
}

/**
 * Every browser tab across the surface's sessions, as rows in a stable order:
 * tabs that were already listed keep their position and only the newcomers are
 * appended, so a title settling or a session re-reporting itself never
 * reshuffles the list under a finger or a cursor.
 *
 * Identity is settled through {@link nextSettledTabIdentity} against the row's
 * own previous identity, which is what keeps a tab mid-navigation from blinking
 * back to "Browser" between the commit and the new document's title.
 */
export function useBrowserSidebarTabRows(
  sessions: readonly BrowserSessionInfo[],
): readonly BrowserSidebarTabRow[] {
  const [state, setState] = useState(() => ({
    sessions,
    rows: nextBrowserSidebarTabRows([], sessions),
  }));
  if (state.sessions === sessions) return state.rows;
  const rows = nextBrowserSidebarTabRows(state.rows, sessions);
  setState({ sessions, rows });
  return rows;
}

export interface BrowserTabRowLabels {
  /** The disambiguating second label a row shows, keyed by row key. */
  readonly secondaryByKey: ReadonlyMap<string, string | null>;
  /** Titles more than one row carries, which close affordances must qualify. */
  readonly duplicateTitles: ReadonlySet<string>;
}

export function useBrowserTabRowLabels(
  tabs: readonly BrowserSidebarTabRow[],
): BrowserTabRowLabels {
  const secondaryByKey = useMemo(
    () =>
      disambiguateSecondaryLabels(
        tabs.map((row) => ({
          key: row.key,
          tabId: row.tab.tabId,
          title: row.identity.title,
          url: row.identity.url,
        })),
      ),
    [tabs],
  );
  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    tabs.forEach((row) => {
      counts.set(row.identity.title, (counts.get(row.identity.title) ?? 0) + 1);
    });
    const duplicates = new Set<string>();
    counts.forEach((count, title) => {
      if (count > 1) duplicates.add(title);
    });
    return duplicates;
  }, [tabs]);
  return { secondaryByKey, duplicateTitles };
}

/** Rows whose title or URL contains `query`; the whole list for a blank one. */
export function filterBrowserTabRows(
  tabs: readonly BrowserSidebarTabRow[],
  query: string,
): readonly BrowserSidebarTabRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return tabs;
  return tabs.filter(({ identity }) =>
    `${identity.title} ${identity.url}`.toLocaleLowerCase().includes(needle),
  );
}
