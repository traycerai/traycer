import { useMemo, useSyncExternalStore } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  browserSessionsCoordinatorEntries,
  subscribeToBrowserSessionsCoordinators,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";

/** One task's live browser inventory, before task titles are attached. */
export interface WarmBrowserEpic {
  readonly epicId: string;
  readonly sessions: ReadonlyArray<BrowserSessionInfo>;
}

const EMPTY_BROWSER_EPICS: ReadonlyArray<WarmBrowserEpic> = [];

/**
 * Every browser tab this window can see, grouped by the task it belongs to.
 *
 * ## It SUBSCRIBES, it never acquires
 *
 * A coordinator is acquired, not observed: taking one out opens a
 * `browser.sessions` stream on its host and holds it for as long as the
 * consumer lives. Home must not do that. It is a page that LISTS browsers, and
 * a list that brings its own subject into existence would open a stream per
 * task the moment the tab was opened, on every host in the fleet, for rows
 * nobody asked to watch.
 *
 * So this reads the REGISTRY - the coordinators some other surface (a mounted
 * epic canvas) already holds - through the two seams that expose it without
 * handing out a reference: `subscribeToBrowserSessionsCoordinators` for the
 * notification, `browserSessionsCoordinatorEntries` for the snapshot. Home
 * therefore keeps nothing alive: closing the last canvas that owned a
 * coordinator drops the stream and the rows go with it, which is the honest
 * reading of a window-local inventory and exactly what
 * `coverage.browsersAreMountedOnly` declares.
 *
 * ## Why the snapshot is content-keyed
 *
 * `useSyncExternalStore` compares snapshots with `===`, and a coordinator
 * spreads its whole state object on EVERY server frame - several per agent
 * browser tool call, plus one per navigation. Rebuilding the grouping per read
 * would hand back a fresh array on every one of those and re-render the whole
 * page at frame rate. The published value is replaced only when the content a
 * row is built from actually changes, the same shape `useWarmChatBackground`
 * and `useLiveBrowserSession` use.
 *
 * ## Why sessions are unioned per epic
 *
 * One epic can have a coordinator per HOST - a task worked from two machines
 * with a browser surface open on each - and each answers only for its own. They
 * are merged under the epic, and each session keeps its own `hostId`, which is
 * what lets the page group these rows by machine like every other row on it.
 */
export function useBrowserSessionsPlane(): ReadonlyArray<WarmBrowserEpic> {
  const source = useMemo(() => createBrowserSessionsPlaneSource(), []);
  return useSyncExternalStore(
    source.subscribe,
    source.read,
    () => EMPTY_BROWSER_EPICS,
  );
}

interface BrowserSessionsPlaneSource {
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the SAME array until its content key changes. */
  readonly read: () => ReadonlyArray<WarmBrowserEpic>;
}

function createBrowserSessionsPlaneSource(): BrowserSessionsPlaneSource {
  let published = EMPTY_BROWSER_EPICS;
  let publishedKey = "";
  return {
    subscribe: (listener) => subscribeToBrowserSessionsCoordinators(listener),
    read: () => {
      const next = readBrowserEpics();
      const key = browserEpicsContentKey(next);
      if (key === publishedKey) return published;
      publishedKey = key;
      published = next;
      return next;
    },
  };
}

function readBrowserEpics(): ReadonlyArray<WarmBrowserEpic> {
  const sessionsByEpicId = new Map<string, BrowserSessionInfo[]>();
  for (const entry of browserSessionsCoordinatorEntries()) {
    // A coordinator that has not delivered its first full snapshot is reporting
    // its PREVIOUS incarnation's items, so its tabs are not yet a claim about
    // this connection. Listing them would let a reconnect briefly show pages
    // that may already be gone.
    if (!entry.state.inventoryReady) continue;
    if (entry.state.items.length === 0) continue;
    const existing = sessionsByEpicId.get(entry.epicId);
    if (existing === undefined) {
      sessionsByEpicId.set(entry.epicId, [...entry.state.items]);
    } else {
      existing.push(...entry.state.items);
    }
  }
  if (sessionsByEpicId.size === 0) return EMPTY_BROWSER_EPICS;
  return Array.from(sessionsByEpicId.entries()).map(([epicId, sessions]) => ({
    epicId,
    sessions,
  }));
}

/**
 * Everything a row is built FROM, and nothing else.
 *
 * `lastActivityAt` and `runtime.revision` move on essentially every frame and
 * change no row on this page, so they are deliberately absent: including them
 * would make the content key change as fast as the object identity it exists to
 * replace. The driving chat ids are in, because the row names the conversation
 * driving the tab.
 */
function browserEpicsContentKey(epics: ReadonlyArray<WarmBrowserEpic>): string {
  return epics
    .map((epic) =>
      [
        epic.epicId,
        ...epic.sessions.map((session) =>
          [
            session.hostId,
            session.sessionId,
            ...session.tabs.map((tab) =>
              [
                tab.tabId,
                tab.title ?? "",
                tab.url,
                tab.status,
                tab.drivenBy.map((driver) => driver.chatId).join(","),
              ].join("|"),
            ),
          ].join("\u001e"),
        ),
      ].join("\u001f"),
    )
    .join("\u001d");
}
