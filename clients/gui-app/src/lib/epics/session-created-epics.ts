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
 * How long the create host stays the SEED for a new epic session's placement.
 *
 * The race this seed closes lasts only until the create host's background
 * cloud connect lands (seconds; a minute-plus only when that host is retrying
 * with backoff). Past this window the cloud record exists and the ordinary
 * rule - the epic session follows the app-wide effective host - is the right
 * one again, so the seed expires rather than pinning every self-created epic
 * to its create host for the whole app session. `wasEpicCreatedThisSession`
 * deliberately does NOT expire: the existence reconciler and the access
 * coordinator's NOT_FOUND grace need the session-lifetime fact, not the
 * placement seed.
 */
const CREATE_HOST_SEED_TTL_MS = 2 * 60 * 1000;

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
 * The host a just-created epic should open its session on, or `null` once the
 * create-host seed has expired (or was never recorded). See
 * {@link CREATE_HOST_SEED_TTL_MS} for why this answer is time-bounded while
 * {@link wasEpicCreatedThisSession} is not.
 */
export function sessionCreatedEpicHostId(epicId: string): string | null {
  const entry = sessionCreatedEpics.get(epicId);
  if (entry === undefined) return null;
  if (Date.now() - entry.recordedAt > CREATE_HOST_SEED_TTL_MS) return null;
  return entry.hostId;
}

export function clearSessionCreatedEpics(): void {
  sessionCreatedEpics.clear();
}
