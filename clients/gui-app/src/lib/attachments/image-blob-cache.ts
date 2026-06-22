/**
 * Content-addressed blob-URL cache for chat image attachments.
 *
 * Chat images are referenced by content hash; their bytes are fetched once
 * per hash and exposed as a single shared `blob:` URL. Every message
 * generation, React fiber, and surface that renders the same image shares
 * that one URL instead of carrying its own base64 copy, so a given image
 * occupies the heap exactly once regardless of how many places reference it.
 *
 * Lifecycle is reference-counted: the URL is revoked once nothing holds it,
 * after a short grace window so scroll/remount churn reuses the live blob. A
 * still-pending fetch is aborted once its last reference drops, and a failed
 * fetch never poisons the entry - the next acquire retries.
 */

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
   * in-flight fetch, so only one fetcher actually runs per hash.
   */
  acquire: (
    hash: string,
    mediaType: string,
    fetcher: ImageBytesFetcher,
  ) => Promise<string>;
  /** Release one reference; the URL is revoked once no references remain. */
  release: (hash: string) => void;
  /** Live entry count (diagnostics/tests). */
  size: () => number;
}

const DEFAULT_REVOKE_GRACE_MS = 10_000;

export function createImageBlobCache(
  ops: ImageBlobOps,
  graceMs: number,
): ImageBlobCache {
  const entries = new Map<string, CacheEntry>();

  const scheduleRevoke = (hash: string, entry: CacheEntry): void => {
    if (entry.cancelRevoke !== null) return;
    const handle = setTimeout(() => {
      entry.cancelRevoke = null;
      if (entry.refCount > 0) return;
      if (entry.url !== null) ops.revoke(entry.url);
      entries.delete(hash);
    }, graceMs);
    entry.cancelRevoke = () => clearTimeout(handle);
  };

  const acquire = (
    hash: string,
    mediaType: string,
    fetcher: ImageBytesFetcher,
  ): Promise<string> => {
    let entry = entries.get(hash);
    if (entry === undefined) {
      entry = {
        refCount: 0,
        url: null,
        inFlight: null,
        abort: null,
        cancelRevoke: null,
      };
      entries.set(hash, entry);
    }
    entry.refCount += 1;
    if (entry.cancelRevoke !== null) {
      entry.cancelRevoke();
      entry.cancelRevoke = null;
    }
    if (entry.url !== null) return Promise.resolve(entry.url);
    if (entry.inFlight !== null) return entry.inFlight;

    const target = entry;
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
    return target.inFlight;
  };

  const release = (hash: string): void => {
    const entry = entries.get(hash);
    if (entry === undefined) return;
    if (entry.refCount > 0) entry.refCount -= 1;
    if (entry.refCount > 0) return;
    if (entry.inFlight !== null) {
      // Nothing wants the bytes anymore - cancel the fetch and drop the entry so
      // its observers/timers tear down; a re-acquire starts a fresh fetch.
      entry.abort?.abort();
      entry.abort = null;
      entry.inFlight = null;
      entries.delete(hash);
      return;
    }
    scheduleRevoke(hash, entry);
  };

  return { acquire, release, size: () => entries.size };
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
