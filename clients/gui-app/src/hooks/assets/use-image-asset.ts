import { useEffect, useMemo, useState } from "react";
import {
  AssetStreamClient,
  type AssetStreamCallbacks,
  type AssetStreamFailure,
  type AssetStreamFailureReason,
  type AssetStreamHeader,
} from "@traycer-clients/shared/host-transport/asset-stream-client";
import type { AssetMediaType } from "@traycer/protocol/host/asset-stream-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  imageBlobCache,
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

interface ImageAssetRequestPrimitives {
  readonly method: "workspace" | "git" | null;
  readonly filePath: string | null;
  readonly workspacePath: string | null;
  readonly runningDir: string | null;
  readonly previousPath: string | null;
  readonly side: "old" | "new" | null;
  readonly stage: "staged" | "unstaged" | null;
}

const EMPTY_REQUEST_PRIMITIVES: ImageAssetRequestPrimitives = {
  method: null,
  filePath: null,
  workspacePath: null,
  runningDir: null,
  previousPath: null,
  side: null,
  stage: null,
};

/**
 * Flattens `request` to primitive fields so `useImageAsset` can build a
 * `useMemo` dependency array that stays stable across renders even when the
 * caller passes a fresh `request` object literal every time.
 */
function extractRequestPrimitives(
  request: ImageAssetRequest | null,
): ImageAssetRequestPrimitives {
  if (request === null) return EMPTY_REQUEST_PRIMITIVES;
  if (request.method === "workspace") {
    return {
      ...EMPTY_REQUEST_PRIMITIVES,
      method: "workspace",
      filePath: request.filePath,
      workspacePath: request.workspacePath,
    };
  }
  return {
    ...EMPTY_REQUEST_PRIMITIVES,
    method: "git",
    filePath: request.filePath,
    runningDir: request.runningDir,
    previousPath: request.previousPath,
    side: request.side,
    stage: request.stage,
  };
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
 * On a repeat mount of the same path whose header reports the SAME
 * `contentIdentity` as an already-cached fetch (a re-focused worktree tile,
 * or a second tile for the same git side), the cache lookup resolves without
 * this fetch's bytes ever being awaited, and the now-redundant stream is
 * closed immediately instead of assembling bytes nobody will use (decision
 * log #11: "bytes only re-transfer when the identity changed").
 */
export function useImageAsset(
  request: ImageAssetRequest | null,
): ImageAssetState {
  const hostId = useTabHostId();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const wsStreamClient = useHostStreamClientFor(target, auth);

  // Normalized to a REFERENCE-STABLE object across renders with the same
  // primitive fields - `request` itself may be a fresh literal every render
  // (mirrors `usePrDetailSubscription`'s `stableArgs`).
  const {
    method,
    filePath,
    workspacePath,
    runningDir,
    previousPath,
    side,
    stage,
  } = extractRequestPrimitives(request);

  const normalizedRequest: ImageAssetRequest | null = useMemo(() => {
    if (method === null || filePath === null) return null;
    if (method === "workspace") {
      if (workspacePath === null) return null;
      return { method: "workspace", workspacePath, filePath };
    }
    if (runningDir === null || side === null || stage === null) return null;
    return { method: "git", runningDir, filePath, previousPath, side, stage };
  }, [method, filePath, workspacePath, runningDir, previousPath, side, stage]);

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
    if (normalizedRequest === null || wsStreamClient === null) {
      return;
    }
    const requestKey = requestKeyFor(normalizedRequest);

    let active = true;
    let cacheKey: string | null = null;
    let client: AssetStreamClient | null = null;
    // Set only while a fetch this hook OWNS (a cache miss) is in flight -
    // bridges this session's `onReady`/onFailure` into the promise
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
              () => reject(new Error("Image asset fetch was cancelled.")),
              { once: true },
            );
          });
        };

        imageBlobCache.acquire(key, header.mediaType, fetcher).then(
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
      client.close();
      if (cacheKey !== null) imageBlobCache.release(cacheKey);
    };
  }, [normalizedRequest, wsStreamClient, hostId]);

  const currentKey =
    normalizedRequest === null ? null : requestKeyFor(normalizedRequest);
  return resolved !== null && resolved.key === currentKey
    ? resolved.state
    : LOADING_STATE;
}
