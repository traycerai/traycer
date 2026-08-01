import { LEGACY_HOST_RESOLVED_AT } from "@traycer/protocol/host/worktree-schemas";

/**
 * The host's derive time for whatever is on screen, or `null` when nothing has
 * been derived yet.
 *
 * The OLDEST stamp across every row wins: a folder list is only as fresh as its
 * stalest folder. `LEGACY_HOST_RESOLVED_AT` (the literal `1`, stamped for rows
 * bridged from a host that predates `resolvedAt`) is dropped rather than
 * rendered - it is a resolved-marker, not a time, and an age computed from it
 * reads as 1970.
 *
 * Deliberately the rows' own `resolvedAt` and not a query's client-side
 * `dataUpdatedAt`: the host serves these listings from a TTL cache, so
 * `dataUpdatedAt` reports "just now" for facts that can be an hour old.
 * Staleness is the entire point of the label, so it has to come from the side
 * that actually does the deriving.
 */
export function oldestResolvedAt(
  stamps: ReadonlyArray<number | null>,
): number | null {
  const real = stamps.flatMap((stamp) =>
    stamp === null || stamp === LEGACY_HOST_RESOLVED_AT ? [] : [stamp],
  );
  return real.length === 0 ? null : Math.min(...real);
}
