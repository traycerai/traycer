/**
 * A client that survives at least this long before closing underneath its owner
 * is considered to have genuinely worked - its close resets the rebuild
 * backoff. Anything shorter is a "quick close": the rebuild likely dials
 * straight into the same failure.
 */
const REBUILD_HEALTHY_LIFETIME_MS = 30_000;
const REBUILD_BACKOFF_BASE_MS = 1_000;
const REBUILD_BACKOFF_MAX_MS = 30_000;

/**
 * Rebuild pacing for a stream-client liveness guard - the "a CLOSED client must
 * be replaced, not left dead until the window reloads" loop that both the
 * app-wide `HostStreamProvider` and the transient per-host binding hook
 * (`useHostStreamClientBindingFor`) run.
 *
 * Without it that loop is hot: a terminal-class close (incompatible protocol,
 * plan restriction, a host too old for the negotiated method) ends every fresh
 * dial the same way, so rebuild → grant mint → relay dial → handshake → same
 * fatal → rebuild, one full cycle per round trip, indefinitely.
 *
 * It lives here, shared, rather than inside either owner, because the two
 * differ ONLY in which host they point at - and the transient one points at
 * whichever machine a person picked, which is exactly the population where
 * terminal-class closes happen. A policy that existed in one of them was a
 * policy the other was always going to need.
 */
export interface StreamRebuildBackoff {
  /** Start a served client's lifetime clock; call where the client is built. */
  readonly markBuilt: (nowMs: number) => void;
  /**
   * How long to wait before the rebuild this close triggers, and the reason
   * this is a mutating read: it also advances (or resets) the quick-close
   * streak, so it must be called exactly once per close.
   */
  readonly nextRebuildDelayMs: (nowMs: number) => number;
}

export function createStreamRebuildBackoff(): StreamRebuildBackoff {
  let quickCloses = 0;
  let builtAt = 0;
  return {
    markBuilt: (nowMs: number): void => {
      builtAt = nowMs;
    },
    nextRebuildDelayMs: (nowMs: number): number => {
      if (nowMs - builtAt >= REBUILD_HEALTHY_LIFETIME_MS) {
        quickCloses = 0;
      } else {
        quickCloses += 1;
      }
      // The FIRST quick close still rebuilds immediately - the guard's whole
      // point is instant recovery from the closed-client wedge. Backoff kicks
      // in from the second consecutive quick close, which is what a
      // terminal-class fatal (each fresh dial ending the same way) looks like
      // and a one-off wedge does not.
      if (quickCloses <= 1) return 0;
      return Math.min(
        REBUILD_BACKOFF_MAX_MS,
        REBUILD_BACKOFF_BASE_MS * 2 ** (quickCloses - 2),
      );
    },
  };
}
