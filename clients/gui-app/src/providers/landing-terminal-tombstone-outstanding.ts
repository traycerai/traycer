import {
  landingTerminalPendingKills,
  useLandingPanelStore,
} from "@/stores/home/landing-panel-store";

/**
 * Whether a TERMINAL tombstone with these ids is still outstanding.
 *
 * One helper for the two retry-arm readers of `pendingKills`, narrowed at the
 * predicate like every other consumer of that mixed list. A browser tombstone
 * carries the device's shared BROWSER session id, from a namespace nothing
 * proves disjoint from terminal ids - which is why `landingTabRefKey` carries a
 * `kind` segment at all. Unnarrowed, a colliding browser tombstone reports a
 * terminal's already-cleared record as outstanding.
 *
 * Its own module, and not a private function in the recovery bridge, for two
 * reasons that point the same way: a `.tsx` that exports one non-component
 * breaks fast refresh for the whole file, and this predicate needs a test of
 * its own. It needs one because its effect is masked downstream - the drain
 * loop narrows its own dispatch list, and `cancelUndrainableCapableCloseRetries`
 * tears down any retry whose key is not in THAT list, so a wrong answer here
 * costs a retry record the next pass reaps rather than a wrong RPC. The
 * predicate is still keyed on the wrong axis, and the next caller need not be
 * behind those two guards.
 */
export function terminalTombstoneOutstanding(pending: {
  readonly hostId: string;
  readonly sessionId: string;
}): boolean {
  return landingTerminalPendingKills(
    useLandingPanelStore.getState().pendingKills,
  ).some(
    (candidate) =>
      candidate.hostId === pending.hostId &&
      candidate.sessionId === pending.sessionId,
  );
}
