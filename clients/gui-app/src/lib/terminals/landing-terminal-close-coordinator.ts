import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";

const pendingByLifetimeKey = new Map<string, Promise<void>>();

/**
 * The one close boundary for a landing terminal's lifetime, shared by the two
 * surfaces that can send it.
 *
 * Closing is tombstone-first: the panel records the tombstone and then sends
 * the close itself as a fast path, while
 * `LandingTerminalTombstoneRecoveryBridge` watches that same tombstone set
 * app-wide and sends the close for any key it has not dispatched before. On an
 * ALREADY-drainable host both fire for one gesture, and they hold separate
 * mutation instances, so nothing in either one can see the other's request.
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
