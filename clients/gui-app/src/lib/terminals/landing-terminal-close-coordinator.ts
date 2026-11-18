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
 * Callers for the same lifetime therefore share one REQUEST rather than racing.
 * Only the caller that owns it may read the settlement as an answer; a joiner
 * has to leave itself able to send its own close later. Either settlement
 * releases the key, so the next attempt can own one.
 *
 * They share the request, not a promise object: each caller gets its own
 * promise carrying `owned`, because only the caller whose `close` actually ran
 * may act on success as though its own RPC succeeded.
 *
 * Mirrors `epic-terminal-close-coordinator`, which draws the same boundary for
 * the epic surfaces.
 */
export interface LandingTerminalCloseOutcome {
  /**
   * Whether THIS caller's `close` is the request that ran.
   *
   * A joiner gets `false`, and that distinction is load-bearing: the key is the
   * terminal's lifetime, not the RPC, so a `terminal.plain.close` can join an
   * in-flight `terminal.kill` for the same session. Those two do not mean the
   * same thing on success - a kill answers an already-gone session with
   * `killed: false` as DATA, and for a `pendingCreate` record the kill mutation
   * deliberately KEEPS the tombstone on that answer.
   *
   * So a joiner that read its fulfilled promise as "my close succeeded" would
   * clear a tombstone the owner had just decided to retain, leaving the created
   * PTY running with no record that it is owed a kill. Whoever owns the request
   * owns the tombstone decision.
   *
   * A joiner is therefore in the same position as a caller whose close FAILED:
   * it has no answer to its own question. Declining to conclude is only half of
   * that - a joiner that also drops its retry, or sits behind an
   * already-attempted latch, never sends the close at all.
   */
  readonly owned: boolean;
}

export function requestLandingTerminalClose(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly close: () => Promise<void>;
}): Promise<LandingTerminalCloseOutcome> {
  const key = plainTerminalFleetIdentityKey({
    hostId: args.hostId,
    terminalId: args.sessionId,
  });
  const existing = pendingByLifetimeKey.get(key);
  if (existing !== undefined) return existing.then(() => ({ owned: false }));

  const pending = Promise.resolve().then(args.close);
  pendingByLifetimeKey.set(key, pending);
  const release = (): void => {
    if (pendingByLifetimeKey.get(key) === pending) {
      pendingByLifetimeKey.delete(key);
    }
  };
  void pending.then(release, release);
  return pending.then(() => ({ owned: true }));
}
