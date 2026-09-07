/**
 * Content-addressed blob-URL cache.
 * Image keys include the authorizing subject; a lease binds the entry instance (ABA-safe).
 */

export type ImageBlobRetention = "grace" | "session";

/** The blob URL, plus the media type it was ACTUALLY created with. */
export interface ImageBlobResolution {
  readonly url: string;
  readonly mediaType: string;
}

export interface ImageBlobLease {
  /** Resolves to the shared blob URL once the fetch (or cache hit) settles. */
  readonly promise: Promise<ImageBlobResolution>;
  /**
   * Releases exactly the reference this lease represents.
   * Idempotent, and a no-op once the entry it was issued against is no longer the hash's live occupant (see the file-level doc comment).
   */
  readonly release: () => void;
}

/** What a byte source hands back: the bytes, and its own verdict on what they are when it has one. */
export interface ImageBytesResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mediaType: string | null;
}

export type ImageBytesFetcher = (
  hash: string,
  signal: AbortSignal,
) => Promise<ImageBytesResult>;

/**
 * Hash plus the subject those bytes are authorized against; omitting the subject would share across an ACL boundary.
 */
export interface ScopedImageBytesFetcher {
  /**
   * Everything this source authorizes against, beyond the hash, as an opaque string.
   * Two acquirers share a blob only when these are equal.
   */
  readonly scopeKey: string;
  readonly fetch: ImageBytesFetcher;
}

/** The cache identity for one hash under one subject. */
export function buildScopedImageCacheKey(
  scopeKey: string,
  hash: string,
): string {
  return JSON.stringify([scopeKey, hash]);
}

/** Object-URL seam. Real impl uses the browser `URL`/`Blob`; tests inject fakes. */
export interface ImageBlobOps {
  readonly create: (
    bytes: Uint8Array<ArrayBuffer>,
    mediaType: string,
  ) => string;
  readonly revoke: (url: string) => void;
}

const browserImageBlobOps: ImageBlobOps = {
  create: (bytes, mediaType) =>
    URL.createObjectURL(new Blob([bytes], { type: mediaType })),
  revoke: (url) => URL.revokeObjectURL(url),
};

interface CacheEntry {
  refCount: number;
  resolved: ImageBlobResolution | null;
  inFlight: Promise<ImageBlobResolution> | null;
  abort: AbortController | null;
  retention: ImageBlobRetention;
  // Cancels the pending revoke timer (null when none is scheduled).
  // We store the canceller, not the timer handle, so this shared file never names the timer type - it compiles under both browser (number) and node (Timeout) lib configs.
  cancelRevoke: (() => void) | null;
}

export interface ImageBlobCache {
  /**
   * Acquire (and ref) the shared blob URL for `hash`, fetching bytes once via `fetcher`.
   * The fetcher is passed per call because the byte source is the tab-scoped host; concurrent acquirers of the same hash reuse the first in-flight fetch, so only one fetcher actually runs per key.
   */
  acquire: (
    /**
     * What the byte source is asked FOR - a content hash, or the composite `buildImageAssetCacheKey` string for workspace assets.
     * NOT the cache key: `acquire` derives that from this and `fetcher.scopeKey`, so a caller cannot hand the fetcher a scoped identity by mistake.
     */
    subject: string,
    mediaType: string,
    fetcher: ScopedImageBytesFetcher,
    retention: ImageBlobRetention,
  ) => ImageBlobLease;
  /** Live entry count (diagnostics/tests). */
  size: () => number;
  /**
   * Force-drops exactly `hash` immediately - revoking its URL and aborting any in-flight fetch - bypassing grace/session retention and IGNORING `refCount`.
   * For a genuinely undecodable-but-magic-valid asset (a decode failure downstream of a successful fetch): the bytes were never wrong, so a normal `release()` would correctly leave a still-referenced or session-retained entry alive, but nothing will ever.
   */
  discard: (scopeKey: string, subject: string) => void;
  /**
   * Test-only: drops every entry immediately, bypassing grace/session retention and revoking every live URL.
   * `"session"`-retention entries exist precisely to outlive their own test otherwise, so a shared cache instance (the app-wide singleton) needs this to stay isolated between tests - never call it from production code.
   */
  clear: () => void;
}

const DEFAULT_REVOKE_GRACE_MS = 10_000;

export function createImageBlobCache(
  ops: ImageBlobOps,
  graceMs: number,
): ImageBlobCache {
  const entries = new Map<string, CacheEntry>();

  const scheduleRevoke = (identity: string, entry: CacheEntry): void => {
    // Session retention (immutable git object bytes, decision #11): a zero-ref entry stays cached for the rest of the app session rather than being revoked after the grace window, so a remount later reuses it instead of re-transferring bytes that cannot have.
    if (entry.retention === "session") return;
    if (entry.cancelRevoke !== null) return;
    const handle = setTimeout(() => {
      entry.cancelRevoke = null;
      if (entry.refCount > 0) return;
      if (entry.resolved !== null) ops.revoke(entry.resolved.url);
      entries.delete(identity);
    }, graceMs);
    entry.cancelRevoke = () => clearTimeout(handle);
  };

  // Releases exactly `target` - the entry instance a lease was issued against - never whatever the map's CURRENT occupant of `hash` happens to be.
  // This is the ABA fix: a `discard()`/prior-`release()` can already have removed `target` from `entries` and a later `acquire()` can already have installed an unrelated replacement there by the time this runs; the `entries.get(identity) !== target` check.
  const releaseEntry = (identity: string, target: CacheEntry): void => {
    if (target.refCount > 0) target.refCount -= 1;
    if (target.refCount > 0) return;
    if (entries.get(identity) !== target) return;
    if (target.inFlight !== null) {
      // Nothing wants the bytes anymore - cancel the fetch and drop the entry so
      // its observers/timers tear down; a re-acquire starts a fresh fetch.
      target.abort?.abort();
      target.abort = null;
      target.inFlight = null;
      entries.delete(identity);
      return;
    }
    scheduleRevoke(identity, target);
  };

  const acquire = (
    subject: string,
    mediaType: string,
    fetcher: ScopedImageBytesFetcher,
    retention: ImageBlobRetention,
  ): ImageBlobLease => {
    // The map key is DERIVED here, never taken from the caller, and the byte source is asked for `subject` - the two roles used to share one `hash` parameter, and a caller that correctly passed a scoped key for the first role thereby asked its RPC for.
    const identity = buildScopedImageCacheKey(fetcher.scopeKey, subject);
    let entry = entries.get(identity);
    if (entry === undefined) {
      entry = {
        refCount: 0,
        resolved: null,
        inFlight: null,
        abort: null,
        retention,
        cancelRevoke: null,
      };
      entries.set(identity, entry);
    }
    entry.refCount += 1;
    if (entry.cancelRevoke !== null) {
      entry.cancelRevoke();
      entry.cancelRevoke = null;
    }

    const target = entry;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseEntry(identity, target);
    };

    if (target.resolved !== null) {
      return { promise: Promise.resolve(target.resolved), release };
    }
    if (target.inFlight !== null) {
      return { promise: target.inFlight, release };
    }

    const controller = new AbortController();
    target.abort = controller;
    // `entries.get(identity) === target` guards every late callback: once an entry
    // is released/replaced, its stale fetch must not resurrect or clobber it.
    target.inFlight = fetcher.fetch(subject, controller.signal).then(
      (result) => {
        if (entries.get(identity) !== target) {
          throw new Error("image blob fetch superseded");
        }
        // The byte source's own verdict outranks the caller's declared type: the caller described bytes it had not seen, the source sniffed the ones it is handing over.
        // `null` means the source has no verdict, so the declared type stands.
        const effectiveMediaType = result.mediaType ?? mediaType;
        const resolved: ImageBlobResolution = {
          url: ops.create(result.bytes, effectiveMediaType),
          mediaType: effectiveMediaType,
        };
        target.resolved = resolved;
        target.inFlight = null;
        target.abort = null;
        // Released while the fetch was in flight: revoke once the grace passes.
        if (target.refCount === 0) scheduleRevoke(identity, target);
        return resolved;
      },
      (error) => {
        if (entries.get(identity) === target) {
          target.inFlight = null;
          target.abort = null;
          // Never leave a poisoned entry: drop it so a later acquire retries.
          entries.delete(identity);
        }
        throw error;
      },
    );
    return { promise: target.inFlight, release };
  };

  const dropEntry = (hash: string, entry: CacheEntry): void => {
    entry.cancelRevoke?.();
    entry.abort?.abort();
    if (entry.resolved !== null) ops.revoke(entry.resolved.url);
    entries.delete(hash);
  };

  const discard = (scopeKey: string, subject: string): void => {
    // Same derivation as `acquire`, for the same reason: the map is keyed by the scoped identity, so a bare subject matches nothing.
    // `discard` is documented as a safe no-op on an absent key, which means a mismatch here fails SILENTLY - the undecodable entry stays live and its URL is never revoked - so it derives rather than accepting a key.
    const identity = buildScopedImageCacheKey(scopeKey, subject);
    const entry = entries.get(identity);
    if (entry === undefined) return;
    dropEntry(identity, entry);
  };

  const clear = (): void => {
    for (const [hash, entry] of entries) dropEntry(hash, entry);
  };

  return { acquire, size: () => entries.size, discard, clear };
}

/**
 * App-wide singleton.
 * Blob URLs are process-global, so a single cache keyed by content hash guarantees one blob per unique image across every tab, surface, and message generation.
 */
export const imageBlobCache: ImageBlobCache = createImageBlobCache(
  browserImageBlobOps,
  DEFAULT_REVOKE_GRACE_MS,
);
