import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";

const pendingByLifetimeKey = new Map<string, Promise<void>>();

/**
 * The one close boundary for a landing terminal's lifetime, shared by every
 * surface that can send it. There are three:
 *
 * Closing is tombstone-first: the panel records the tombstone and then sends
 * the close itself as a fast path, while
 * `LandingTerminalTombstoneRecoveryBridge` watches that same tombstone set
 * app-wide and sends the close for any key it has not dispatched before. On an
 * ALREADY-drainable host both fire for one gesture, and they hold separate
 * mutation instances, so nothing in either one can see the other's request.
 *
 * Landing-terminal RECONCILIATION is the third, on BOTH of its arms - the
 * capable pass closing a projected tombstone, and the legacy pass killing a
 * listed one. Each drains the same tombstone set the bridge does, off the same
 * evidence, so a retained tombstone whose create lands late wakes both on the
 * very same update.
 *
 * Anything that closes or kills a landing terminal must come through here. A
 * sender that reaches for `mutations.close` or the kill mutation directly
 * reintroduces exactly the race below - and `terminal.kill` is no safer for
 * being non-throwing: it answers `killed: false` about a session the winner
 * already removed, which is the one answer a `pendingCreate` tombstone must
 * keep treating as ambiguous.
 *
 * Two concurrent `terminal.plain.close` calls for one terminal means the loser
 * fails on a terminal the winner already removed - and that failure is not
 * silent: the mutation's `onError` raises "Couldn't close the terminal.", so a
 * close that SUCCEEDED reports itself as broken.
 *
 * Callers for the same lifetime therefore share the exact in-flight promise
 * rather than racing, and each still observes the real settlement to clear its
 * tombstone or schedule its own retry. Either settlement releases the key, so a
 * genuine failure can be retried.
 *
 * Mirrors `epic-terminal-close-coordinator`, which draws the same boundary for
 * the epic surfaces.
 */
export function requestLandingTerminalClose(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly close: () => Promise<void>;
}): Promise<void> {
  const key = plainTerminalFleetIdentityKey({
    hostId: args.hostId,
    terminalId: args.sessionId,
  });
  const existing = pendingByLifetimeKey.get(key);
  if (existing !== undefined) return existing;

  const pending = Promise.resolve().then(args.close);
  pendingByLifetimeKey.set(key, pending);
  const release = (): void => {
    if (pendingByLifetimeKey.get(key) === pending) {
      pendingByLifetimeKey.delete(key);
    }
  };
  void pending.then(release, release);
  return pending;
}
