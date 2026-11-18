/**
 * Spacing before each relaunch, indexed by how many have already been made; the
 * last entry repeats. Deliberately faster off the mark than the desktop
 * governor's `[0, 60_000, 300_000]`: that one arbitrates while a user is
 * present and other recovery exists, whereas here the host is provably dead and
 * nothing else is watching. Caps at a minute so a machine that cannot start a
 * host is not hammered.
 *
 * Its own module because two sides read it: the supervisor that sleeps it
 * (`commands/host-start.ts`), and a start that finds that supervisor alive and
 * waits out its relaunch instead of starting over it
 * (`host/service-supervisor-relaunch.ts`).
 */
export const RELAUNCH_BACKOFF_MS: readonly number[] = [
  1_000, 5_000, 15_000, 30_000, 60_000,
];
