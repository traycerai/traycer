/**
 * The reader's content-addressed part cache.
 * Eviction exists, but purely as a space policy the adapter owns; it is never a correctness mechanism, and no caller ever has a reason to ask for one.
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
 * For an environment with no durable store, and for the ablation that proves the request-count tests are measuring the cache rather than something else: with this installed, every read fetches every part.
 */
export const NO_PART_CACHE: ChatPartCache = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
};

/** Process-lifetime cache. */
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
