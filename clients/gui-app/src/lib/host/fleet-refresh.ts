import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

/**
 * Renderer-side seam for "the fleet changed; the authority must re-read it"
 * (redesign P1.2, F6).
 *
 * Deregistering a host refreshes renderer state only - the directory service
 * and the registered-hosts query. The authority that derives `effectiveHostId`
 * lives in the desktop main process and learns nothing, so its fleet keeps a
 * host the account no longer has, and derivation can name a machine that is
 * gone.
 *
 * **A shell capability, not the window's authority surface.** The type is
 * deliberately `Pick<IRunnerHost, …>` rather than anything on
 * `SelectionAuthorityClient`: this change spent its whole budget narrowing the
 * selection WRITE path to one bridge plus Settings ▸ Activate, and announcing
 * a membership change must not widen it again. This says "tell the shell its
 * copy is stale", never "select something".
 */
export type FleetRefreshCapableShell = Pick<IRunnerHost, "refreshHostFleet">;

/**
 * Announce that this account's host fleet changed.
 *
 * Fire-and-forget on purpose, and safe precisely because the renderer asserts
 * NOTHING about membership here - only that main's copy is stale. A duplicate
 * or late call costs one refetch and can never publish a falsehood; and
 * nothing downstream of the deregistration depends on it having completed, so
 * awaiting it would only delay the user's toast behind an unrelated round
 * trip.
 *
 * The outcome is not read here: a mutation is not discovery, and the host
 * directory's own fleet requests are what track an `unavailable` fleet and
 * re-ask on the next poll. A renderer that retried here would be a second
 * decider.
 */
export function requestFleetRefresh(shell: FleetRefreshCapableShell): void {
  void shell.refreshHostFleet();
}
