/**
 * Epic ids created from the start-page landing composer during the CURRENT app
 * session - both the GUI-chat flow and the terminal-agent flow - each with the
 * host the create was sent on. Written synchronously at create time (before
 * navigation, before the epic-tab existence reconciler can seed a run), so a
 * freshly-created epic is never force-closed during the window where
 * `epic.listTasks` still lags `epic.create`.
 *
 * An epic created this session is by definition NOT a stale persisted tab from
 * a prior session, which is the only thing the existence reconciler should
 * prune. The GUI-chat flow is also covered by its active initial-chat handoff,
 * but the terminal-agent flow registers no handoff and its live epic session
 * may not be in the registry yet when the reconcile close fires (the session
 * acquire races the reconcile RPC, and on desktop waits on an async ownership
 * claim) - so this synchronous marker is the deterministic guard both flows
 * share.
 *
 * The HOST is recorded because `epic.create` is local-first ON THAT HOST: the
 * create host seeds a warm in-memory slot and writes the cloud record only in
 * a deferred background connect. Until that connect lands, the create host is
 * the ONLY machine that can serve the epic - any other host cold-opens, asks
 * the cloud, and gets an adjudicated-looking NOT_FOUND for an epic that
 * provably exists. `sessionCreatedEpicHostId` is what lets the session open
 * against the create host instead.
 *
 * Entries are cheap (a uuid string + host id, bounded by how many epics a user
 * creates in one session), so there is no eviction. Cleared on sign-out /
 * user-switch via `clearSessionCreatedEpics` so a new identity starts fresh.
 */

interface SessionCreatedEpicEntry {
  readonly hostId: string;
  readonly recordedAt: number;
}

const sessionCreatedEpics = new Map<string, SessionCreatedEpicEntry>();

/**
 * How long a create is still RACING its own cloud record - the window both
 * consumers of the create host are scoped to.
 *
 * The race lasts only until the create host's background cloud connect lands
 * (seconds; a minute-plus only when that host is retrying with backoff). Past
 * it the cloud record exists, so a NOT_FOUND means what it says and the
 * ordinary rule - the epic session follows the app-wide effective host - is
 * right again.
 *
 * Both layers read the window through this one constant, deliberately:
 * {@link sessionCreatedEpicHostId} for session placement, and the access
 * coordinator's silent-retry grace through
 * {@link wasEpicCreatedRecentlyThisSession}. Scoping the grace to the SESSION
 * instead would let a transient NOT_FOUND hours later trigger a destructive
 * `requestFreshSnapshot` on an epic that has since accumulated real work.
 *
 * {@link wasEpicCreatedThisSession} is the odd one out and does NOT expire:
 * the existence reconciler asks whether this renderer created the epic at
 * all, which is a fact about the session, not about the race.
 */
const CREATE_RACE_WINDOW_MS = 2 * 60 * 1000;

function isWithinCreateRaceWindow(entry: SessionCreatedEpicEntry): boolean {
  return Date.now() - entry.recordedAt <= CREATE_RACE_WINDOW_MS;
}

/**
 * The access coordinator's silent re-subscribe schedule for an `unavailable`
 * (cloud `NOT_FOUND`) verdict on an epic still inside the window above - each
 * entry the delay before one `requestFreshSnapshot`, the eject running only
 * once the last one is spent.
 *
 * It lives here, beside the window it serves, rather than in the coordinator:
 * that is a component module, and a constant exported from one breaks Fast
 * Refresh (`react/only-export-components`). Co-locating also keeps the two
 * create-race timings legible against each other.
 *
 * The TOTAL is what matters, and it is sized to outlast a create that is
 * STILL IN FLIGHT rather than to look tidy. The terminal-agent flow opens its
 * tab before the `epic.create` round-trip, so this schedule can be spent
 * while the create has not returned - and the host's own RPC deadline is 30s
 * (`ws-rpc-client.ts`), so a shorter schedule ejects a tab whose epic was
 * still legitimately being created, leaving it in history only: the very bug
 * the grace exists to prevent. 62s covers that deadline with margin.
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
 * Drop a single marker when the optimistic create fails, so a tab whose epic
 * never landed on the host is no longer exempt from existence reconciliation.
 */
export function unmarkEpicCreatedThisSession(epicId: string): void {
  sessionCreatedEpics.delete(epicId);
}

export function wasEpicCreatedThisSession(epicId: string): boolean {
  return sessionCreatedEpics.has(epicId);
}

/**
 * Whether this renderer created the epic and the create is still racing its
 * own cloud record - the only window in which an absence may be read as lag
 * rather than as the delete the code says it is. See
 * {@link CREATE_RACE_WINDOW_MS}.
 */
export function wasEpicCreatedRecentlyThisSession(epicId: string): boolean {
  const entry = sessionCreatedEpics.get(epicId);
  if (entry === undefined) return false;
  return isWithinCreateRaceWindow(entry);
}

/**
 * The host a just-created epic should open its session on, or `null` once the
 * create race is over (or the epic was not created here). See
 * {@link CREATE_RACE_WINDOW_MS} for why this answer is time-bounded while
 * {@link wasEpicCreatedThisSession} is not.
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
