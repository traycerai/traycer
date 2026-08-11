import { useEffect, useRef, useState } from "react";
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
import {
  buildImageAssetCacheKey,
  type ImageAssetSource,
} from "@/lib/assets/image-asset-cache-key";

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
  /** Byte progress ticket 04 may render; `totalBytes` is `null` until the header arrives. */
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
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
  receivedBytes: 0,
  totalBytes: null,
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

function assetSourceFor(request: ImageAssetRequest): ImageAssetSource {
  if (request.method === "workspace") return "workspace";
  return request.side === "old" ? "git-old" : "git-new";
}

function assetPathFor(request: ImageAssetRequest): string {
  return request.method === "workspace"
    ? `${request.workspacePath}::${request.filePath}`
    : `${request.runningDir}::${request.filePath}`;
}

/**
 * Identifies WHICH request a resolved `ImageAssetState` belongs to, so a
 * request change can be told apart from a stream event that is still in
 * flight for the previous one - the same "does this resolved value still
 * belong to the current key" shape `useImageBlobUrlState` uses. Deliberately
 * NOT the blob-cache key: this exists before the header (and its
 * `contentIdentity`) ever arrives.
 */
function requestKeyFor(request: ImageAssetRequest): string {
  return request.method === "workspace"
    ? `workspace|${request.workspacePath}|${request.filePath}`
    : `git|${request.runningDir}|${request.filePath}|${request.previousPath ?? ""}|${request.side}|${request.stage}`;
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

/** Built directly from primitive fields, inside the effect that needs it (no memoization - see the hook's doc comment). */
function buildImageAssetRequest(fields: {
  readonly method: "workspace" | "git" | null;
  readonly filePath: string | null;
  readonly workspacePath: string | null;
  readonly runningDir: string | null;
  readonly previousPath: string | null;
  readonly side: "old" | "new" | null;
  readonly stage: "staged" | "unstaged" | null;
}): ImageAssetRequest | null {
  const { method, filePath } = fields;
  if (method === null || filePath === null) return null;
  if (method === "workspace") {
    if (fields.workspacePath === null) return null;
    return { method, workspacePath: fields.workspacePath, filePath };
  }
  const { runningDir, previousPath, side, stage } = fields;
  if (runningDir === null || side === null || stage === null) return null;
  return { method, runningDir, filePath, previousPath, side, stage };
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
 * `request` is reduced to primitive fields (not a `useMemo`-stabilized
 * object) precisely because the caller passes a fresh literal every render;
 * the effect below depends on those primitives directly and reconstructs the
 * typed request from them itself - `buildImageAssetRequest` is a plain
 * function, not a hook, so it needs no memoization to stay cheap.
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
): ImageAssetState {
  const hostId = useTabHostId();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const wsStreamClient = useHostStreamClientFor(target, auth);
  const paneFocused = usePaneFocused();

  const method = request?.method ?? null;
  const filePath = request?.filePath ?? null;
  const workspacePath =
    request?.method === "workspace" ? request.workspacePath : null;
  const [runningDir, previousPath, side, stage] =
    request?.method === "git"
      ? ([
          request.runningDir,
          request.previousPath,
          request.side,
          request.stage,
        ] as const)
      : ([null, null, null, null] as const);

  const currentRequest = buildImageAssetRequest({
    method,
    filePath,
    workspacePath,
    runningDir,
    previousPath,
    side,
    stage,
  });
  const isWorktreeBacked =
    currentRequest !== null && isWorktreeBackedRequest(currentRequest);

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

  useEffect(() => {
    const normalizedRequest = buildImageAssetRequest({
      method,
      filePath,
      workspacePath,
      runningDir,
      previousPath,
      side,
      stage,
    });
    if (normalizedRequest === null || wsStreamClient === null) {
      return;
    }
    const requestKey = requestKeyFor(normalizedRequest);
    const retention: ImageBlobRetention = isWorktreeBackedRequest(
      normalizedRequest,
    )
      ? "grace"
      : "session";

    let active = true;
    let cacheKey: string | null = null;
    let client: AssetStreamClient | null = null;
    // Set only while a fetch this hook OWNS (a cache miss) is in flight -
    // bridges this session's `onReady`/`onFailure` into the promise
    // `imageBlobCache.acquire`'s fetcher returned. Stays `null` on a cache
    // hit, since the fetcher is then never invoked.
    let settleFetch: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
    let rejectFetch: ((error: Error) => void) | null = null;
    let usedForFetch = false;
    // Threads the human-readable reason through the cache's generic
    // Promise rejection: `onFailure` knows WHY (`describeFailure`), but the
    // `imageBlobCache.acquire(...).catch` below only sees that the fetcher's
    // promise rejected, not the `AssetStreamFailure` that caused it.
    let pendingFailureMessage: string | null = null;

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
            receivedBytes: 0,
            totalBytes: header.sizeBytes,
          },
        });

        const key = buildImageAssetCacheKey({
          hostId,
          source: assetSourceFor(normalizedRequest),
          path: assetPathFor(normalizedRequest),
          contentIdentity: header.contentIdentity,
        });
        cacheKey = key;

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

        imageBlobCache.acquire(key, header.mediaType, fetcher, retention).then(
          (url) => {
            if (!active) return;
            // Cache hit: `fetcher` above was never invoked, so this
            // session's chunks are unneeded - close it instead of
            // assembling bytes nobody will use.
            if (!usedForFetch) client?.close();
            setResolved({
              key: requestKey,
              state: {
                status: "ready",
                url,
                meta,
                reason: null,
                receivedBytes: header.sizeBytes,
                totalBytes: header.sizeBytes,
              },
            });
          },
          () => {
            if (!active) return;
            setResolved({
              key: requestKey,
              state: {
                status: "fallback",
                url: null,
                meta: null,
                reason:
                  pendingFailureMessage ?? "This image could not be loaded.",
                receivedBytes: 0,
                totalBytes: header.sizeBytes,
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
          pendingFailureMessage = describeFailure(failure);
          rejectFetch(new Error(failure.message));
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
            receivedBytes: 0,
            totalBytes: null,
          },
        });
      },
      onConnectionStatus: () => undefined,
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
      // If this fetch is the shared cache entry's OWNER (`usedForFetch`),
      // its stream must outlive THIS unmount when other consumers still
      // hold a reference - closing it here would strand every sibling on
      // the header skeleton forever, since only the owner's `onReady` /
      // `onFailure` ever settles the shared promise. `imageBlobCache.release`
      // below is what may still close it, via the fetcher's abort listener,
      // but only once the LAST reference drops. A fetch that never became
      // the owner (never reached `onHeader`, or lost the cache race) has no
      // such shared responsibility - nothing else will ever close it, so it
      // must be closed directly.
      if (!usedForFetch) client.close();
      if (cacheKey !== null) imageBlobCache.release(cacheKey);
    };
  }, [
    method,
    filePath,
    workspacePath,
    runningDir,
    previousPath,
    side,
    stage,
    wsStreamClient,
    hostId,
    focusRefreshNonce,
  ]);

  const currentKey =
    currentRequest === null ? null : requestKeyFor(currentRequest);
  return resolved !== null && resolved.key === currentKey
    ? resolved.state
    : LOADING_STATE;
}
