import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssetStreamClient,
  type AssetStreamCallbacks,
  type AssetStreamFailure,
  type AssetStreamFailureReason,
  type AssetStreamHeader,
} from "@traycer-clients/shared/host-transport/asset-stream-client";
import type { AssetMediaType } from "@traycer/protocol/host/asset-stream-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  imageBlobCache,
  type ImageBlobRetention,
  type ImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";

/**
 * Which side of which surface an image asset came from - the routing part of
 * the blob-cache key (image-preview decision log, decision #11).
 */
type ImageAssetSource = "workspace" | "git-old" | "git-new";

export type ImageAssetStatus = "loading" | "header" | "ready" | "fallback";

export interface ImageAssetMeta {
  readonly mediaType: AssetMediaType;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ImageAssetState {
  readonly status: ImageAssetStatus;
  readonly url: string | null;
  readonly meta: ImageAssetMeta | null;
  /** Human-readable one-liner, set only at `status === "fallback"`. */
  readonly reason: string | null;
  /** `null` until the header arrives. */
  readonly totalBytes: number | null;
  /** Meaningful only at `status === "ready"` - whether `url` resolved from the shared `imageBlobCache` (`fetcher` below never ran) rather than a fresh stream. See `ImagePreviewProps.servedFromCache` for why a consumer needs this. */
  readonly servedFromCache: boolean;
}

export interface UseImageAssetResult extends ImageAssetState {
  /**
   * Call from an `<img onError>` (or equivalent decode-failure signal) once
   * `status === "ready"`: the fetched bytes were valid enough to reach a
   * blob URL, but the browser could not decode them as an image (magic-byte
   * validation passed host-side; decoding is a client-only concern). Force-
   * discards the exact cache entry this asset resolved to - bypassing grace
   * AND session retention, since a decode failure means the URL will never
   * be consumed again regardless of how long it would otherwise be kept -
   * and transitions this hook's own state to `"fallback"` so callers can
   * drop any local decode-failed flag and render straight from hook state.
   * Safe to call more than once, or after unmount (a stale `<img>` error
   * racing teardown): idempotent, and a no-op past the first call's effect.
   */
  readonly reportDecodeFailure: () => void;
}

export type ImageAssetRequest =
  | {
      readonly method: "workspace";
      readonly workspacePath: string;
      readonly filePath: string;
    }
  | {
      readonly method: "git";
      readonly runningDir: string;
      readonly filePath: string;
      readonly previousPath: string | null;
      readonly side: "old" | "new";
      readonly stage: "staged" | "unstaged";
    };

const LOADING_STATE: ImageAssetState = {
  status: "loading",
  url: null,
  meta: null,
  reason: null,
  totalBytes: null,
  servedFromCache: false,
};

/**
 * Every `AssetStreamFailureReason` maps to the SAME uniform fallback UI
 * (image-preview decision log, decision #14) - this is only the one-line
 * message shown alongside it.
 */
const FAILURE_MESSAGES: Record<AssetStreamFailureReason, string> = {
  "unsupported-method": "This host does not support image previews yet.",
  fatal: "This image could not be loaded.",
  interrupted: "The image transfer was interrupted.",
  "length-mismatch": "The image transfer did not complete.",
  "not-found": "This file could not be found.",
  "not-image": "This file is not one of the supported image formats.",
  mismatch: "This file's contents do not match its extension.",
  "too-large": "This image is too large to preview.",
  "too-many-pixels": "This image's dimensions are too large to preview.",
  "read-failed": "This image could not be read.",
};

function describeFailure(failure: AssetStreamFailure): string {
  return FAILURE_MESSAGES[failure.reason];
}

const DECODE_FAILURE_REASON = "This image could not be decoded.";

function assetSourceFor(request: ImageAssetRequest): ImageAssetSource {
  if (request.method === "workspace") return "workspace";
  return request.side === "old" ? "git-old" : "git-new";
}

/** A workspace path or git running-dir can legally contain `::`/`|` - the request's own fields go into `buildImageAssetCacheKey`/`requestKeyFor` as SEPARATE array elements (JSON-encoded), never delimiter-joined into one string first. */
function locationFor(request: ImageAssetRequest): string {
  return request.method === "workspace"
    ? request.workspacePath
    : request.runningDir;
}

/**
 * Composite key for `imageBlobCache`: `hostId`/`source`/location/`filePath`/
 * `contentIdentity` (image-preview decision log, decision #11), as a JSON
 * array - not delimiter-joined, since any of those fields can legally
 * contain the delimiter and alias two different files onto the same key.
 * Git object sides are immutable by OID, so their key never changes for the
 * life of the session; worktree files carry a `size:mtimeMs` fingerprint as
 * `contentIdentity`, so a re-stat that finds the same fingerprint reuses the
 * cached blob instead of re-transferring bytes.
 */
function buildImageAssetCacheKey(parts: {
  readonly hostId: string;
  readonly source: ImageAssetSource;
  readonly location: string;
  readonly filePath: string;
  readonly contentIdentity: string;
}): string {
  return JSON.stringify([
    parts.hostId,
    parts.source,
    parts.location,
    parts.filePath,
    parts.contentIdentity,
  ]);
}

/**
 * Identifies WHICH request a resolved `ImageAssetState` belongs to, so a
 * request change can be told apart from a stream event that is still in
 * flight for the previous one - the same "does this resolved value still
 * belong to the current key" shape `useImageBlobUrlState` uses. Deliberately
 * NOT the blob-cache key: this exists before the header (and its
 * `contentIdentity`) ever arrives. JSON-encoded for the same reason as
 * `buildImageAssetCacheKey` - a delimiter-joined string can't tell a `|` in a
 * path apart from the join itself.
 */
function requestKeyFor(request: ImageAssetRequest): string {
  return request.method === "workspace"
    ? JSON.stringify(["workspace", request.workspacePath, request.filePath])
    : JSON.stringify([
        "git",
        request.runningDir,
        request.filePath,
        request.previousPath,
        request.side,
        request.stage,
      ]);
}

/**
 * Whether `request` reads live filesystem bytes that can change independently
 * of any git object identity - the workspace file itself, or a git side's
 * "new" position while unstaged (worktree via fs, per the tech plan's
 * side-selection table). Every other git side (staged/HEAD/index reads) is
 * immutable for the life of the session (decision #11): it must neither
 * re-fetch on refocus nor lose its cached blob to grace-window revocation.
 */
function isWorktreeBackedRequest(request: ImageAssetRequest): boolean {
  if (request.method === "workspace") return true;
  return request.side === "new" && request.stage === "unstaged";
}

/**
 * Fetches one image asset - a workspace file or one side of a git-tracked
 * file - over the ticket-01 asset stream, surfacing the header before bytes
 * finish (for an aspect-ratio skeleton) and sharing the assembled bytes'
 * blob URL through the content-addressed `imageBlobCache`.
 *
 * Resolves the host transport from the CURRENT TAB (`useTabHostId` ->
 * `useHostStreamClientFor`), never the renderer-default host - mirrors
 * `usePrDetailSubscription`'s tab-scoped stream pattern.
 *
 * The caller passes a fresh `request` literal every render, so the fetch
 * effect below depends on `requestKeyFor(request)` (a string, stable across
 * renders for the same logical request) rather than `request` itself - a
 * same-key request is guaranteed field-equivalent, so `latestRequestRef`
 * (kept in sync every render, read only inside the effect) is always the
 * right one to act on whenever the effect actually re-runs.
 *
 * On a re-focus of a worktree-backed request (a workspace file, or a git
 * side's unstaged worktree position), the stream reopens to re-stat the file
 * (decision #11); immutable git-object sides never do. Whichever request
 * OWNS the shared cache fetch (the first to reach a given identity) keeps its
 * stream alive across its own unmount as long as the cache still has other
 * consumers - only the cache's own last-reference-drops abort, or this
 * fetch's own terminal frame, closes it - so a sibling `useImageAsset` still
 * mid-fetch is never stranded on the header skeleton nor poisoned by an
 * unrelated unmount.
 */
export function useImageAsset(
  request: ImageAssetRequest | null,
): UseImageAssetResult {
  const hostId = useTabHostId();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const wsStreamClient = useHostStreamClientFor(target, auth);
  const paneFocused = usePaneFocused();

  const requestKey = request === null ? null : requestKeyFor(request);
  const latestRequestRef = useRef(request);
  useEffect(() => {
    latestRequestRef.current = request;
  });
  const isWorktreeBacked = request !== null && isWorktreeBackedRequest(request);

  // Re-stat on refocus (decision #11): only a worktree-backed request bumps
  // this on the pane's blurred->focused transition, so a still-mounted tile
  // reopens the stream and picks up an externally edited file. An immutable
  // git-object request never bumps it - refetching would only re-confirm the
  // same OID.
  const wasFocusedRef = useRef(paneFocused);
  const [focusRefreshNonce, setFocusRefreshNonce] = useState(0);
  useEffect(() => {
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = paneFocused;
    if (paneFocused && !wasFocused && isWorktreeBacked) {
      setFocusRefreshNonce((nonce) => nonce + 1);
    }
  }, [paneFocused, isWorktreeBacked]);

  // Render-time derived state, mirroring `useImageBlobUrlState`: only stream
  // callbacks (genuinely async - fired later, in response to WS events) ever
  // call `setResolved`. Nothing resets it synchronously inside the effect
  // body, so a request change is instead detected below by comparing
  // `resolved.key` against the CURRENT request's key - `resolved` from a
  // superseded request simply stops matching and `LOADING_STATE` shows
  // until the new request's own callbacks resolve.
  const [resolved, setResolved] = useState<{
    readonly key: string;
    readonly state: ImageAssetState;
  } | null>(null);

  // Lets `reportDecodeFailure` - a STABLE callback that outlives any single
  // effect invocation - reach the CURRENT fetch cycle's cache key and act
  // safely regardless of mount state. `isMountedRef`/`requestKeyRef` are
  // shared across invocations by design (React guarantees the OLD effect's
  // cleanup runs before the NEW one's setup, so they always reflect the
  // LATEST invocation once its setup has run); `cacheKeyRef` likewise, but
  // is only ever written from inside an `onHeader` that already checked
  // ITS OWN invocation's local `active` flag, so a superseded invocation's
  // late header can never clobber it with a stale key.
  const isMountedRef = useRef(false);
  const cacheKeyRef = useRef<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);

  const reportDecodeFailure = useCallback((): void => {
    const cacheKey = cacheKeyRef.current;
    if (cacheKey !== null) {
      imageBlobCache.discard(cacheKey);
    }
    if (!isMountedRef.current) return;
    const requestKey = requestKeyRef.current;
    if (requestKey === null) return;
    setResolved({
      key: requestKey,
      state: {
        status: "fallback",
        url: null,
        meta: null,
        reason: DECODE_FAILURE_REASON,
        totalBytes: null,
        servedFromCache: false,
      },
    });
  }, []);

  useEffect(() => {
    const normalizedRequest = latestRequestRef.current;
    if (normalizedRequest === null || wsStreamClient === null) {
      isMountedRef.current = false;
      cacheKeyRef.current = null;
      requestKeyRef.current = null;
      return;
    }
    const requestKey = requestKeyFor(normalizedRequest);
    isMountedRef.current = true;
    cacheKeyRef.current = null;
    requestKeyRef.current = requestKey;
    const retention: ImageBlobRetention = isWorktreeBackedRequest(
      normalizedRequest,
    )
      ? "grace"
      : "session";

    let active = true;
    let releaseLease: (() => void) | null = null;
    let client: AssetStreamClient | null = null;
    // Set only while a fetch this hook OWNS (a cache miss) is in flight -
    // bridges this session's `onReady`/`onFailure` into the promise
    // `imageBlobCache.acquire`'s fetcher returned. Stays `null` on a cache
    // hit, since the fetcher is then never invoked.
    let settleFetch: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
    let rejectFetch: ((error: Error) => void) | null = null;
    let usedForFetch = false;

    const callbacks: AssetStreamCallbacks = {
      onHeader: (header: AssetStreamHeader) => {
        if (!active) return;
        const meta: ImageAssetMeta = {
          mediaType: header.mediaType,
          sizeBytes: header.sizeBytes,
          width: header.width,
          height: header.height,
        };
        setResolved({
          key: requestKey,
          state: {
            status: "header",
            url: null,
            meta,
            reason: null,
            totalBytes: header.sizeBytes,
            servedFromCache: false,
          },
        });

        const key = buildImageAssetCacheKey({
          hostId,
          source: assetSourceFor(normalizedRequest),
          location: locationFor(normalizedRequest),
          filePath: normalizedRequest.filePath,
          contentIdentity: header.contentIdentity,
        });
        cacheKeyRef.current = key;

        const fetcher: ImageBytesFetcher = (_key, signal) => {
          usedForFetch = true;
          return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("Image asset fetch was cancelled."));
              return;
            }
            settleFetch = resolve;
            rejectFetch = reject;
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("Image asset fetch was cancelled."));
                // The cache aborts ONLY once the last reference to this
                // identity drops (`imageBlobCache.release`) - that is the
                // one moment this stream, which may be OWNED by a
                // component other than the one that spawned it, is truly
                // unneeded. A spawning component's own unmount must not
                // reach this: see the cleanup below.
                client?.close();
              },
              { once: true },
            );
          });
        };

        const lease = imageBlobCache.acquire(
          key,
          header.mediaType,
          fetcher,
          retention,
        );
        releaseLease = lease.release;
        // `usedForFetch` is fully decided the instant `acquire` returns -
        // it only ever flips true from INSIDE `fetcher`, called (if at all)
        // synchronously within `acquire`'s own call stack (image-blob-cache.ts:
        // a cache hit or an already-in-flight entry never invokes it). A
        // losing consumer's own stream is therefore redundant right now, not
        // only once the shared lease resolves - closing it here instead of
        // in the `.then()` below stops the host from reading/enqueuing the
        // same bytes twice for the full duration of the owner's transfer.
        if (!usedForFetch) client?.close();

        lease.promise.then(
          (url) => {
            if (!active) return;
            setResolved({
              key: requestKey,
              state: {
                status: "ready",
                url,
                meta,
                reason: null,
                totalBytes: header.sizeBytes,
                // `usedForFetch` is exactly "did the fetcher run" - false
                // means `imageBlobCache.acquire` resolved this lease from
                // an existing entry without ever invoking it.
                servedFromCache: !usedForFetch,
              },
            });
          },
          (error: unknown) => {
            if (!active) return;
            setResolved({
              key: requestKey,
              state: {
                status: "fallback",
                url: null,
                meta: null,
                reason:
                  error instanceof Error
                    ? error.message
                    : "This image could not be loaded.",
                totalBytes: header.sizeBytes,
                servedFromCache: false,
              },
            });
          },
        );
      },
      onReady: (_header, bytes) => {
        // Copies into a fresh, real-`ArrayBuffer`-backed array rather than
        // trusting the concatenated view's generic parameter, matching this
        // codebase's established idiom at the same Uint8Array<ArrayBuffer>
        // boundary (`useEpicImageFetcher`).
        settleFetch?.(new Uint8Array(bytes));
      },
      onFailure: (failure: AssetStreamFailure) => {
        if (rejectFetch !== null) {
          rejectFetch(new Error(describeFailure(failure)));
          return;
        }
        if (!active) return;
        setResolved({
          key: requestKey,
          state: {
            status: "fallback",
            url: null,
            meta: null,
            reason: describeFailure(failure),
            totalBytes: null,
            servedFromCache: false,
          },
        });
      },
    };

    client =
      normalizedRequest.method === "workspace"
        ? new AssetStreamClient({
            wsStreamClient,
            method: "workspace.streamAsset",
            params: {
              workspacePath: normalizedRequest.workspacePath,
              filePath: normalizedRequest.filePath,
            },
            callbacks,
          })
        : new AssetStreamClient({
            wsStreamClient,
            method: "git.streamFileAsset",
            params: {
              runningDir: normalizedRequest.runningDir,
              filePath: normalizedRequest.filePath,
              previousPath: normalizedRequest.previousPath,
              side: normalizedRequest.side,
              stage: normalizedRequest.stage,
            },
            callbacks,
          });

    return () => {
      active = false;
      isMountedRef.current = false;
      // If this fetch is the shared cache entry's OWNER (`usedForFetch`),
      // its stream must outlive THIS unmount when other consumers still
      // hold a reference - closing it here would strand every sibling on
      // the header skeleton forever, since only the owner's `onReady` /
      // `onFailure` ever settles the shared promise. `releaseLease()` below
      // is what may still close it, via the fetcher's abort listener, but
      // only once the LAST reference to the SAME entry this lease was
      // issued against drops - never a same-hash entry that replaced it (a
      // `discard()`, e.g. `reportDecodeFailure`, in between). A fetch that
      // never became the owner (never reached `onHeader`, or lost the cache
      // race) has no such shared responsibility - nothing else will ever
      // close it, so it must be closed directly.
      if (!usedForFetch) client.close();
      releaseLease?.();
    };
  }, [requestKey, wsStreamClient, hostId, focusRefreshNonce]);

  const state =
    resolved !== null && resolved.key === requestKey
      ? resolved.state
      : LOADING_STATE;
  return { ...state, reportDecodeFailure };
}
