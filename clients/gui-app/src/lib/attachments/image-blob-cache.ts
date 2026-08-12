/**
 * Content-addressed blob-URL cache, keyed on an opaque string identity.
 *
 * Chat image attachments key on content hash; their bytes are fetched once
 * per hash and exposed as a single shared `blob:` URL. Every message
 * generation, React fiber, and surface that renders the same image shares
 * that one URL instead of carrying its own base64 copy, so a given image
 * occupies the heap exactly once regardless of how many places reference it.
 * Workspace/git image assets (`useImageAsset`) key on a composite
 * `hostId + source + path + contentIdentity` string built by
 * `buildImageAssetCacheKey` instead - the cache itself is agnostic to what
 * the key encodes, so both callers share the same lifecycle unchanged.
 *
 * Lifecycle is reference-counted: a `"grace"`-retention URL is revoked once
 * nothing holds it, after a short grace window so scroll/remount churn
 * reuses the live blob; a `"session"`-retention URL (an immutable git
 * object, per image-preview decision #11) is never revoked once created,
 * only ever dropped by a page reload. A still-pending fetch is aborted once
 * its last reference drops regardless of retention, and a failed fetch never
 * poisons the entry - the next acquire retries.
 *
 * `acquire()` returns a LEASE bound to the exact entry instance it was
 * issued against, not a hash string a caller separately remembers. This
 * closes an ABA hole a bare `release(hash)` had: `discard()` can delete an
 * entry out from under still-mounted holders (a decode failure force-drops
 * regardless of who else references it) and a LATER `acquire()` for the
 * same hash then creates a genuinely new entry: a stale holder's release
 * must affect only the (now orphaned, unreachable) entry it actually leased,
 * never a same-hash replacement that happens to occupy the map afterward.
 * `lease.release()` captures that entry directly, so it is a no-op the
 * moment the map's occupant at that hash is no longer the same object -
 * whether from `discard()`, `clear()`, or a prior `release()` already
 * having dropped it.
 */

export type ImageBlobRetention = "grace" | "session";

export interface ImageBlobLease {
  /** Resolves to the shared blob URL once the fetch (or cache hit) settles. */
  readonly promise: Promise<string>;
  /**
   * Releases exactly the reference this lease represents. Idempotent, and a
   * no-op once the entry it was issued against is no longer the hash's live
   * occupant (see the file-level doc comment).
   */
  readonly release: () => void;
}

export type ImageBytesFetcher = (
  hash: string,
  signal: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

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
  url: string | null;
  inFlight: Promise<string> | null;
  abort: AbortController | null;
  retention: ImageBlobRetention;
  // Cancels the pending revoke timer (null when none is scheduled). We store the
  // canceller, not the timer handle, so this shared file never names the timer
  // type - it compiles under both browser (number) and node (Timeout) lib configs.
  cancelRevoke: (() => void) | null;
}

export interface ImageBlobCache {
  /**
   * Acquire (and ref) the shared blob URL for `hash`, fetching bytes once via
   * `fetcher`. The fetcher is passed per call because the byte source is the
   * tab-scoped host; concurrent acquirers of the same hash reuse the first
   * in-flight fetch, so only one fetcher actually runs per hash. `retention`
   * is read only when this call CREATES the entry - later acquirers of the
   * same hash must agree with the first caller (the key already encodes
   * whether the content is immutable), so it is not re-applied on a hit.
   * Returns a lease bound to the exact entry acquired - release it, not a
   * remembered hash, when the caller is done (see the file-level doc
   * comment on why a bare hash is unsafe here).
   */
  acquire: (
    hash: string,
    mediaType: string,
    fetcher: ImageBytesFetcher,
    retention: ImageBlobRetention,
  ) => ImageBlobLease;
  /** Live entry count (diagnostics/tests). */
  size: () => number;
  /**
   * Force-drops exactly `hash` immediately - revoking its URL and aborting
   * any in-flight fetch - bypassing grace/session retention and IGNORING
   * `refCount`. For a genuinely undecodable-but-magic-valid asset (a decode
   * failure downstream of a successful fetch): the bytes were never wrong,
   * so a normal `release()` would correctly leave a still-referenced or
   * session-retained entry alive, but nothing will ever consume that URL
   * again. Safe to call with a hash that is not (or no longer) cached - a
   * no-op. A later `acquire()` for the same identity starts a fresh fetch.
   */
  discard: (hash: string) => void;
  /**
   * Test-only: drops every entry immediately, bypassing grace/session
   * retention and revoking every live URL. `"session"`-retention entries
   * exist precisely to outlive their own test otherwise, so a shared cache
   * instance (the app-wide singleton) needs this to stay isolated between
   * tests - never call it from production code.
   */
  clear: () => void;
}

const DEFAULT_REVOKE_GRACE_MS = 10_000;

export function createImageBlobCache(
  ops: ImageBlobOps,
  graceMs: number,
): ImageBlobCache {
  const entries = new Map<string, CacheEntry>();

  const scheduleRevoke = (hash: string, entry: CacheEntry): void => {
    // Session retention (immutable git object bytes, decision #11): a
    // zero-ref entry stays cached for the rest of the app session rather
    // than being revoked after the grace window, so a remount later reuses
    // it instead of re-transferring bytes that cannot have changed.
    if (entry.retention === "session") return;
    if (entry.cancelRevoke !== null) return;
    const handle = setTimeout(() => {
      entry.cancelRevoke = null;
      if (entry.refCount > 0) return;
      if (entry.url !== null) ops.revoke(entry.url);
      entries.delete(hash);
    }, graceMs);
    entry.cancelRevoke = () => clearTimeout(handle);
  };

  // Releases exactly `target` - the entry instance a lease was issued
  // against - never whatever the map's CURRENT occupant of `hash` happens
  // to be. This is the ABA fix: a `discard()`/prior-`release()` can already
  // have removed `target` from `entries` and a later `acquire()` can already
  // have installed an unrelated replacement there by the time this runs; the
  // `entries.get(hash) !== target` check below is what stops this stale
  // release from touching that live replacement.
  const releaseEntry = (hash: string, target: CacheEntry): void => {
    if (target.refCount > 0) target.refCount -= 1;
    if (target.refCount > 0) return;
    if (entries.get(hash) !== target) return;
    if (target.inFlight !== null) {
      // Nothing wants the bytes anymore - cancel the fetch and drop the entry so
      // its observers/timers tear down; a re-acquire starts a fresh fetch.
      target.abort?.abort();
      target.abort = null;
      target.inFlight = null;
      entries.delete(hash);
      return;
    }
    scheduleRevoke(hash, target);
  };

  const acquire = (
    hash: string,
    mediaType: string,
    fetcher: ImageBytesFetcher,
    retention: ImageBlobRetention,
  ): ImageBlobLease => {
    let entry = entries.get(hash);
    if (entry === undefined) {
      entry = {
        refCount: 0,
        url: null,
        inFlight: null,
        abort: null,
        retention,
        cancelRevoke: null,
      };
      entries.set(hash, entry);
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
      releaseEntry(hash, target);
    };

    if (target.url !== null) {
      return { promise: Promise.resolve(target.url), release };
    }
    if (target.inFlight !== null) {
      return { promise: target.inFlight, release };
    }

    const controller = new AbortController();
    target.abort = controller;
    // `entries.get(hash) === target` guards every late callback: once an entry
    // is released/replaced, its stale fetch must not resurrect or clobber it.
    target.inFlight = fetcher(hash, controller.signal).then(
      (bytes) => {
        if (entries.get(hash) !== target) {
          throw new Error("image blob fetch superseded");
        }
        const url = ops.create(bytes, mediaType);
        target.url = url;
        target.inFlight = null;
        target.abort = null;
        // Released while the fetch was in flight: revoke once the grace passes.
        if (target.refCount === 0) scheduleRevoke(hash, target);
        return url;
      },
      (error) => {
        if (entries.get(hash) === target) {
          target.inFlight = null;
          target.abort = null;
          // Never leave a poisoned entry: drop it so a later acquire retries.
          entries.delete(hash);
        }
        throw error;
      },
    );
    return { promise: target.inFlight, release };
  };

  const dropEntry = (hash: string, entry: CacheEntry): void => {
    entry.cancelRevoke?.();
    entry.abort?.abort();
    if (entry.url !== null) ops.revoke(entry.url);
    entries.delete(hash);
  };

  const discard = (hash: string): void => {
    const entry = entries.get(hash);
    if (entry === undefined) return;
    dropEntry(hash, entry);
  };

  const clear = (): void => {
    for (const [hash, entry] of entries) dropEntry(hash, entry);
  };

  return { acquire, size: () => entries.size, discard, clear };
}

/**
 * App-wide singleton. Blob URLs are process-global, so a single cache keyed by
 * content hash guarantees one blob per unique image across every tab, surface,
 * and message generation.
 */
export const imageBlobCache: ImageBlobCache = createImageBlobCache(
  browserImageBlobOps,
  DEFAULT_REVOKE_GRACE_MS,
);
