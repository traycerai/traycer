import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

/**
 * Renderer-side seam for "the fleet changed; the authority must re-read it"
 * (redesign P1.2 fixup F6).
 *
 * Deregistering a host refreshes renderer state only - the directory service
 * and the registered-hosts query. The authority that derives `effectiveHostId`
 * lives in the desktop main process and learns nothing, so its fleet keeps a
 * host the account no longer has, and derivation can name a machine that is
 * gone.
 *
 * **A shell capability, not the window's authority surface.** The type is
 * deliberately `Pick<IRunnerHost, …>` rather than anything on
 * `SelectionAuthorityClient`: this ticket spent its whole budget narrowing the
 * selection WRITE path to one bridge plus Settings ▸ Activate, and announcing
 * a membership change must not widen it again. This says "tell the shell its
 * copy is stale", never "select something".
 */
export type FleetRefreshCapableShell = Pick<IRunnerHost, "refreshHostFleet">;

/**
 * Announce that this account's host fleet changed.
 *
 * Fire-and-forget on purpose, and safe precisely because the renderer asserts
 * NOTHING about membership here - only that main's copy is stale. There is no
 * result to branch on, so a duplicate or late call costs one refetch and can
 * never publish a falsehood; and nothing downstream of the deregistration
 * depends on it having completed, so awaiting it would only delay the user's
 * toast behind an unrelated round trip.
 *
 * The rejection is swallowed for the same reason: a failed refresh leaves main
 * exactly as stale as it already was, and the authority's own evidence kernel
 * is what recovers. A renderer that retried here would be a second decider.
 */
export function requestFleetRefresh(shell: FleetRefreshCapableShell): void {
  void shell.refreshHostFleet().catch(() => undefined);
}
