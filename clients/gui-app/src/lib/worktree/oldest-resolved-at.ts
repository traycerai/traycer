import { LEGACY_HOST_RESOLVED_AT } from "@traycer/protocol/host/worktree-schemas";

/** The host's derive time for whatever is on screen, or `null` when nothing has been derived yet. */
export function oldestResolvedAt(
  stamps: ReadonlyArray<number | null>,
): number | null {
  const real = stamps.flatMap((stamp) =>
    stamp === null || stamp === LEGACY_HOST_RESOLVED_AT ? [] : [stamp],
  );
  return real.length === 0 ? null : Math.min(...real);
}
