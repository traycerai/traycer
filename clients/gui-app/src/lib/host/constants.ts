/**
 * Placeholder hostId used by renderer code that needs to construct an
 * artifact (chat, terminal, tui-agent) before a real host binding has
 * been resolved - for example, in error/loading states or when a host
 * provider has not produced an active id yet, and on legacy artifacts
 * created before per-tile host binding existed.
 *
 * IT DOES NOT FAIL REACHABILITY, and this doc used to claim it did (audit
 * F24). `useHostReachability` answers "reachable" for it ON PURPOSE, and says
 * so at its own arm: a row carrying this placeholder has no host of its own to
 * be unreachable, so it renders against whichever host the renderer is
 * currently using rather than going dead. Making the placeholder fail the
 * check would take every legacy row down with it.
 *
 * What the sentinel is FOR is the affordance gate: branch on
 * {@link isUnknownHost} where an action needs a real host (see
 * `agent-stop-button`), so the user gets a "no host selected" state instead of
 * a silently-broken one. Reachability is the wrong instrument for that
 * question and never answered it.
 */
export const UNKNOWN_HOST_PLACEHOLDER = "__no-host__";

export function isUnknownHost(id: string): boolean {
  return id === UNKNOWN_HOST_PLACEHOLDER;
}
