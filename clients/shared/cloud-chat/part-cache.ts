/**
 * The reader's content-addressed part cache.
 *
 * ## Why this interface has no `invalidate`
 *
 * A part is named by the sha256 of its own bytes, so a key and its value are
 * the same fact stated twice. Nothing can make a stored entry WRONG - only
 * absent - which deletes the entire cache-coherence problem: there is no TTL to
 * tune, no version to stamp, no publication to invalidate against, and no way
 * for a stale entry to be served in place of a fresh one. Eviction exists, but
 * purely as a space policy the adapter owns; it is never a correctness
 * mechanism, and no caller ever has a reason to ask for one.
 *
 * That is what makes a returning reader incremental. After a new turn the chat's
 * head names one new tail shard and the same digests as before for everything
 * else, so the reader asks the host for the head and exactly one part. v1 had no
 * equivalent: its reader refetched the base and every segment after each
 * compaction, which is the read-side half of why the incremental layer was
 * abandoned.
 *
 * ## What an adapter must guarantee
 *
 * 1. `get(h)` returns bytes that were passed to `put(h, ...)`, or `null`.
 * 2. A `put` that fails is a NO-OP, not a throw: a full disk or a denied quota
 *    must cost a re-fetch next time, never a failed read now. Adapters swallow
 *    their own storage errors.
 * 3. Entries survive process restarts. An in-memory adapter is legitimate for
 *    tests and for a fallback when persistent storage is unavailable, but it
 *    buys none of the property above across sessions.
 *
 * Deliberately NOT guaranteed: that `get` returns bytes matching the key. The
 * reader re-hashes what it reads back (see `stagePart`) and treats a mismatch as
 * a MISS, so a corrupted or substituted entry costs a refetch rather than being
 * trusted or being reported as a corrupt publication. An adapter is a store, not
 * a trust boundary.
 */
export interface ChatPartCache {
  /** Cached bytes for this digest, or `null` when absent. Never throws. */
  get(sha256: string): Promise<Uint8Array | null>;
  /**
   * Stores bytes under their digest. Idempotent by construction. Failures are
   * swallowed - see the contract above.
   */
  put(sha256: string, bytes: Uint8Array): Promise<void>;
}

/**
 * A cache that stores nothing.
 *
 * For an environment with no durable store, and for the ablation that proves the
 * request-count tests are measuring the cache rather than something else: with
 * this installed, every read fetches every part.
 */
export const NO_PART_CACHE: ChatPartCache = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
};

/**
 * Process-lifetime cache. Used by tests, and as the fallback an adapter falls
 * back TO when its persistent store is unavailable - a session-scoped cache is
 * strictly better than none for a reader that scrolls one chat repeatedly.
 */
export class InMemoryChatPartCache implements ChatPartCache {
  private readonly entries = new Map<string, Uint8Array>();

  get(sha256: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.entries.get(sha256) ?? null);
  }

  put(sha256: string, bytes: Uint8Array): Promise<void> {
    this.entries.set(sha256, bytes);
    return Promise.resolve();
  }

  /** Entry count, for tests and for an adapter reporting its own size. */
  get size(): number {
    return this.entries.size;
  }
}
