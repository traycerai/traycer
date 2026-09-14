import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import {
  browserTabHostname,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import {
  compareAscending,
  shallowEqualRow,
  stabilizeRows,
} from "@/lib/home-focus/focus-identity";
import {
  focusAgentKey,
  type FocusAgentIdentity,
} from "@/lib/home-focus/focus-tasks";
import type {
  FocusBrowserRow,
  FocusBrowserStatus,
} from "@/lib/home-focus/focus-model";

/**
 * One task's live browser inventory, as the hook read it off the coordinator
 * registry.
 *
 * Several coordinators can answer for one epic - one per host with a browser
 * surface open - so `sessions` is their union rather than any single stream's
 * items. Each session names its own host, which is why nothing here needs a
 * host of its own.
 */
export interface FocusBrowserEpic {
  readonly epicId: string;
  readonly taskTitle: string | null;
  readonly sessions: ReadonlyArray<BrowserSessionInfo>;
}

export interface FocusBrowsersInput {
  readonly epics: ReadonlyArray<FocusBrowserEpic>;
  /** {@link focusAgentKey} → identity, for mounted epics only. A CHAT agent's
   * id IS its chat id, so the map the task rows are already built from answers
   * "what is the conversation driving this tab called" with no second read. */
  readonly agentIdentities: ReadonlyMap<string, FocusAgentIdentity>;
}

/**
 * The "Browsers" section: one row per browser TAB, across every task whose
 * canvas is open in this window.
 *
 * The user's ask this answers: "even if multiple browsers are running inside
 * some task, I should be able to somehow view and directly click to go there."
 * So sessions are not a level - a task running two browsers over four pages is
 * four rows, each with its own title and url, and each a click away from the
 * tile it names.
 *
 * MOUNTED ONLY, irreducibly for now. `browser.sessions` is a per-scope stream
 * and the client sees an inventory only where some surface has already opened
 * one, so a browser in a task nobody has opened here is invisible whatever this
 * page asks. That is the caption's premise, and `coverage.browsersAreMountedOnly`
 * is where the type records it.
 *
 * ORDERING is total and stable rather than "most recent": epic, then host, then
 * session, then the tab's own position in its session. The last part is the
 * sidebar's order - the sequence the host reports, which is the order the tabs
 * were opened in - so a page keeps its place when a title settles or a
 * navigation commits. Sorting by activity would move rows under the cursor
 * every time an agent touched a page, which is the opposite of what a list you
 * click through is for.
 *
 * There is NO stop control anywhere in this section, and that is a decision
 * rather than a gap: closing a tab is a canvas action on the tile itself, and a
 * cross-task page offering to close pages it cannot show would be destroying
 * state the reader cannot see.
 */
export function buildFocusBrowsers(
  input: FocusBrowsersInput,
  previous: ReadonlyArray<FocusBrowserRow>,
): ReadonlyArray<FocusBrowserRow> {
  const placed = input.epics.flatMap((epic) =>
    epic.sessions.flatMap((session) =>
      session.tabs.map((tab, tabIndex) => ({
        tabIndex,
        row: buildBrowserRow(epic, session, tab, input.agentIdentities),
      })),
    ),
  );
  placed.sort(compareFocusBrowsers);
  return stabilizeRows(
    placed.map((entry) => entry.row),
    previous,
    shallowEqualRow,
  );
}

/** A row and the one fact that orders it without belonging in the model: where
 * its tab sits in its own session. */
interface PlacedBrowserRow {
  readonly tabIndex: number;
  readonly row: FocusBrowserRow;
}

function buildBrowserRow(
  epic: FocusBrowserEpic,
  session: BrowserSessionInfo,
  tab: BrowserTabInfo,
  agentIdentities: ReadonlyMap<string, FocusAgentIdentity>,
): FocusBrowserRow {
  const title = resolveTabTitle(tab);
  const urlHost = browserTabHostname(tab.url);
  // `drivenBy` is a list because several requests can be in flight at once;
  // the row names the first, because "which conversation is this page for" has
  // one useful answer and a list of chat ids is not it.
  const drivenByChatId = tab.drivenBy.at(0)?.chatId ?? null;
  return {
    key: focusBrowserKey(session.hostId, session.sessionId, tab.tabId),
    epicId: epic.epicId,
    taskTitle: epic.taskTitle,
    hostId: session.hostId,
    sessionId: session.sessionId,
    tabId: tab.tabId,
    title,
    // Dropped when the title fell back to it, so the row reads `example.com`
    // rather than `example.com · example.com` for every page whose document
    // title has not arrived.
    urlHost: urlHost === null || urlHost === title ? null : urlHost,
    url: tab.url,
    status: focusBrowserStatus(tab.status),
    drivenByChatId,
    drivenByAgentName:
      drivenByChatId === null
        ? null
        : (agentIdentities.get(focusAgentKey(epic.epicId, drivenByChatId))
            ?.title ?? null),
  };
}

/** The row's key, and the same composite the browser sidebar keys its tab rows
 * by - one tab has one identity wherever it is listed. */
export function focusBrowserKey(
  hostId: string,
  sessionId: string,
  tabId: string,
): string {
  return compositeKey(hostId, sessionId, tabId);
}

/** See {@link FocusBrowserStatus} for why six wire states become three. */
export function focusBrowserStatus(
  status: BrowserTabInfo["status"],
): FocusBrowserStatus {
  if (status === "crashed") return "crashed";
  if (status === "dormant") return "dormant";
  return "live";
}

function compareFocusBrowsers(
  a: PlacedBrowserRow,
  b: PlacedBrowserRow,
): number {
  const epicDelta = compareAscending(a.row.epicId, b.row.epicId);
  if (epicDelta !== 0) return epicDelta;
  const hostDelta = compareAscending(a.row.hostId, b.row.hostId);
  if (hostDelta !== 0) return hostDelta;
  const sessionDelta = compareAscending(a.row.sessionId, b.row.sessionId);
  if (sessionDelta !== 0) return sessionDelta;
  const tabDelta = a.tabIndex - b.tabIndex;
  return tabDelta === 0 ? compareAscending(a.row.tabId, b.row.tabId) : tabDelta;
}

/** Browser rows by epic id, for the Tasks view's nesting. */
export function browsersByEpicId(
  browsers: ReadonlyArray<FocusBrowserRow>,
): ReadonlyMap<string, ReadonlyArray<FocusBrowserRow>> {
  const byEpicId = new Map<string, FocusBrowserRow[]>();
  for (const row of browsers) {
    const existing = byEpicId.get(row.epicId);
    if (existing === undefined) byEpicId.set(row.epicId, [row]);
    else existing.push(row);
  }
  return byEpicId;
}

/**
 * The tab titles a browser PROMPT can be decorated with, keyed by the
 * `sessionId`/`tabId` its payload names.
 *
 * Built from the same rows the section renders, so a prompt can never name a
 * tab the page below it is not showing.
 */
export function focusBrowserTabTitles(
  browsers: ReadonlyArray<FocusBrowserRow>,
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const row of browsers) {
    titles.set(browserTabTitleKey(row.sessionId, row.tabId), row.title);
  }
  return titles;
}

/** A session id and a tab id are both opaque strings, so they join on the NUL
 * neither can carry - the same separator {@link focusAgentKey} uses. */
export function browserTabTitleKey(sessionId: string, tabId: string): string {
  return `${sessionId}\u0000${tabId}`;
}

/** The epics with at least one browser row, for the Tasks view's union. */
export function epicIdsWithBrowsers(
  browsers: ReadonlyArray<FocusBrowserRow>,
): ReadonlySet<string> {
  return new Set(browsers.map((row) => row.epicId));
}
