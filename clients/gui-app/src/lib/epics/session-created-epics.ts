/**
 * Epic ids created from the start-page landing composer during the CURRENT app session - both the GUI-chat flow and the terminal-agent flow - each with the host the create was sent on.
 */

interface SessionCreatedEpicEntry {
  readonly hostId: string;
  readonly recordedAt: number;
}

const sessionCreatedEpics = new Map<string, SessionCreatedEpicEntry>();

/**
 * How long a create is still RACING its own cloud record - the window both consumers of the create host are scoped to.
 */
const CREATE_RACE_WINDOW_MS = 2 * 60 * 1000;

function isWithinCreateRaceWindow(entry: SessionCreatedEpicEntry): boolean {
  return Date.now() - entry.recordedAt <= CREATE_RACE_WINDOW_MS;
}

/**
 * The access coordinator's silent re-subscribe schedule for an `unavailable` (cloud `NOT_FOUND`) verdict on an epic still inside the window above - each entry the delay before one `requestFreshSnapshot`, the eject running only once the last one is spent.
 */
export const CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  2_000, 5_000, 10_000, 15_000, 30_000,
];

export function markEpicCreatedThisSession(
  epicId: string,
  hostId: string,
): void {
  sessionCreatedEpics.set(epicId, { hostId, recordedAt: Date.now() });
}

/**
 * Drop a single marker when the optimistic create fails, so a tab whose epic never landed on the host is no longer exempt from existence reconciliation.
 */
export function unmarkEpicCreatedThisSession(epicId: string): void {
  sessionCreatedEpics.delete(epicId);
}

export function wasEpicCreatedThisSession(epicId: string): boolean {
  return sessionCreatedEpics.has(epicId);
}

/**
 * Whether this renderer created the epic and the create is still racing its own cloud record - the only window in which an absence may be read as lag rather than as the delete the code says it is.
 */
export function wasEpicCreatedRecentlyThisSession(epicId: string): boolean {
  const entry = sessionCreatedEpics.get(epicId);
  if (entry === undefined) return false;
  return isWithinCreateRaceWindow(entry);
}

/**
 * The host a just-created epic should open its session on, or `null` once the create race is over (or the epic was not created here).
 * See {@link CREATE_RACE_WINDOW_MS} for why this answer is time-bounded while {@link wasEpicCreatedThisSession} is not.
 */
export function sessionCreatedEpicHostId(epicId: string): string | null {
  const entry = sessionCreatedEpics.get(epicId);
  if (entry === undefined) return null;
  if (!isWithinCreateRaceWindow(entry)) return null;
  return entry.hostId;
}

export function clearSessionCreatedEpics(): void {
  sessionCreatedEpics.clear();
}
