/**
 * Epic ids created from the start-page landing composer during the CURRENT app
 * session - both the GUI-chat flow and the terminal-agent flow. Written
 * synchronously at create time (before navigation, before the epic-tab
 * existence reconciler can seed a run), so a freshly-created epic is never
 * force-closed during the window where `epic.listTasks` still lags
 * `epic.create`.
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
 * Entries are cheap (a uuid string, bounded by how many epics a user creates in
 * one session), so there is no eviction. Cleared on sign-out / user-switch via
 * `clearSessionCreatedEpics` so a new identity starts fresh.
 */
const sessionCreatedEpicIds = new Set<string>();

export function markEpicCreatedThisSession(epicId: string): void {
  sessionCreatedEpicIds.add(epicId);
}

/**
 * Drop a single marker when the optimistic create fails, so a tab whose epic
 * never landed on the host is no longer exempt from existence reconciliation.
 */
export function unmarkEpicCreatedThisSession(epicId: string): void {
  sessionCreatedEpicIds.delete(epicId);
}

export function wasEpicCreatedThisSession(epicId: string): boolean {
  return sessionCreatedEpicIds.has(epicId);
}

export function clearSessionCreatedEpics(): void {
  sessionCreatedEpicIds.clear();
}
