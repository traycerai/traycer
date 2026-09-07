import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssetStreamClient,
  type AssetStreamCallbacks,
  type AssetStreamFailure,
  type AssetStreamFailureReason,
  type AssetStreamHeader,
} from "@traycer-clients/shared/host-transport/asset-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { AssetMediaType } from "@traycer/protocol/host/asset-stream-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientBindingFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  imageBlobCache,
  type ImageBlobRetention,
  type ImageBytesFetcher,
  type ImageBytesResult,
} from "@/lib/attachments/image-blob-cache";
import { isPdfAssetPath } from "@/lib/assets/image-extension-allowlist";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/** Which side of which surface an image asset came from - the routing part of the blob-cache key (image-preview decision log, decision #11). */
type FileAssetSource = "workspace" | "git-old" | "git-new";

export type FileAssetStatus = "loading" | "header" | "ready" | "fallback";

export interface FileAssetMeta {
  readonly mediaType: AssetMediaType;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
}

export interface FileAssetState {
  readonly status: FileAssetStatus;
  readonly url: string | null;
  readonly meta: FileAssetMeta | null;
  /** Human-readable one-liner, set only at `status === "fallback"`. */
  readonly reason: string | null;
  /** `null` until the header arrives. */
  readonly totalBytes: number | null;
  /** Meaningful only at `status === "ready"` - whether `url` resolved from the shared `imageBlobCache` (`fetcher` below never ran) rather than a fresh stream. See `ImagePreviewProps.servedFromCache` for why a consumer needs this. */
  readonly servedFromCache: boolean;
}

export interface UseFileAssetResult extends FileAssetState {
  /** Decode failure: discard this cache entry (bypass grace/retention) and go to fallback. Idempotent. */
  readonly reportDecodeFailure: () => void;
}

export type FileAssetRequest =
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
      /** Pre-header coalescing only. Different git revisions must not share one in-flight stream. */
      readonly coalesceRevision: string;
    };

const LOADING_STATE: FileAssetState = {
  status: "loading",
  url: null,
  meta: null,
  reason: null,
  totalBytes: null,
  servedFromCache: false,
};

/** What the asset renders AS on the client - decides failure copy (and the PdfPreview vs ImagePreview routing at the surfaces). */
export type FileAssetRenderKind = "image" | "document";

/** Every `AssetStreamFailureReason` maps to the SAME uniform fallback UI (image-preview decision log, decision #14) - this is only the one-line message shown alongside it, per render kind so a PDF failure never reads as an image bug ("not one of the supported image formats" next to a PDF that the app usually previews would read as broken, not as a limit). */
const IMAGE_FAILURE_MESSAGES: Record<AssetStreamFailureReason, string> = {
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

const DOCUMENT_FAILURE_MESSAGES: Record<AssetStreamFailureReason, string> = {
  "unsupported-method": "This host does not support PDF previews yet.",
  fatal: "This PDF could not be loaded.",
  interrupted: "The file transfer was interrupted.",
  "length-mismatch": "The file transfer did not complete.",
  "not-found": "This file could not be found.",
  // The wire literal is historical ("unsupported asset type") - for a PDF request it means the host refused admission, i.e.
  "not-image": "This host does not support PDF previews yet.",
  mismatch: "This file's contents do not match its extension.",
  "too-large": "This PDF is too large to preview.",
  // Host never emits this for a PDF (raster-specific check) - generic copy.
  "too-many-pixels": "This PDF could not be previewed.",
  "read-failed": "This PDF could not be read.",
};

function describeFailure(
  failure: AssetStreamFailure,
  renderKind: FileAssetRenderKind,
): string {
  return renderKind === "document"
    ? DOCUMENT_FAILURE_MESSAGES[failure.reason]
    : IMAGE_FAILURE_MESSAGES[failure.reason];
}

const DECODE_FAILURE_REASONS: Record<FileAssetRenderKind, string> = {
  image: "This image could not be decoded.",
  document: "This PDF could not be rendered.",
};

function assetSourceFor(request: FileAssetRequest): FileAssetSource {
  if (request.method === "workspace") return "workspace";
  return request.side === "old" ? "git-old" : "git-new";
}

/** the pdf half of `report.pdf -> report.bin` image failure copy and drop its PDF telemetry. */
function renderPathFor(request: FileAssetRequest): string {
  if (request.method === "git" && request.side === "old") {
    return request.previousPath ?? request.filePath;
  }
  return request.filePath;
}

/** A workspace path or git running-dir can legally contain `::`/`|` - the request's own fields go into `buildFileAssetCacheKey`/`requestKeyFor` as SEPARATE array elements (JSON-encoded), never delimiter-joined into one string first. */
function locationFor(request: FileAssetRequest): string {
  return request.method === "workspace"
    ? request.workspacePath
    : request.runningDir;
}

/** JSON array key, never delimiter-joined (paths can contain the delimiter). */
/** A constant rather than a per-request value because {@link buildFileAssetCacheKey} already carries this hook's whole authorization surface (host, source, location, path) in the subject. */
const FILE_ASSET_SCOPE_KEY = "file-asset";

function buildFileAssetCacheKey(parts: {
  readonly hostId: string;
  readonly source: FileAssetSource;
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

/** Pre-header request identity. Not the blob-cache key. JSON-encoded, never delimiter-joined. */
function requestKeyFor(request: FileAssetRequest): string {
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

/** Wider than requestKeyFor: include coalesceRevision and the module-global focusRefreshGeneration (never a per-hook counter).
 * Non-worktree requests canonicalize generation to 0 so a prop transition cannot carry a stale generation into a git request. */
function sharedSubscriptionKeyFor(
  hostId: string,
  request: FileAssetRequest,
  focusRefreshGeneration: number,
): string {
  return JSON.stringify([
    hostId,
    requestKeyFor(request),
    request.method === "git" ? request.coalesceRevision : null,
    isWorktreeBackedRequest(request) ? focusRefreshGeneration : 0,
  ]);
}

/** Workspace files and unstaged git "new" sides can change independently of object identity. Other git sides are session-immutable. */
function isWorktreeBackedRequest(request: FileAssetRequest): boolean {
  if (request.method === "workspace") return true;
  return request.side === "new" && request.stage === "unstaged";
}

function openAssetStreamClient(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  request: FileAssetRequest,
  callbacks: AssetStreamCallbacks,
): AssetStreamClient {
  return request.method === "workspace"
    ? new AssetStreamClient({
        wsStreamClient,
        method: "workspace.streamAsset",
        params: {
          workspacePath: request.workspacePath,
          filePath: request.filePath,
        },
        callbacks,
      })
    : new AssetStreamClient({
        wsStreamClient,
        method: "git.streamFileAsset",
        params: {
          runningDir: request.runningDir,
          filePath: request.filePath,
          previousPath: request.previousPath,
          side: request.side,
          stage: request.stage,
        },
        callbacks,
      });
}

interface SharedAssetSubscription {
  readonly client: AssetStreamClient;
  refCount: number;
  /** The one-time `assetHeader` this entry's client already delivered, if any - retained so a joiner arriving AFTER it fired (but before settle) still gets it, since the underlying client itself only ever calls `onHeader` once. */
  readonly headerBox: { current: AssetStreamHeader | null };
  readonly headerListeners: Set<(header: AssetStreamHeader) => void>;
  readonly readyListeners: Set<
    (header: AssetStreamHeader, bytes: Uint8Array) => void
  >;
  readonly failureListeners: Set<(failure: AssetStreamFailure) => void>;
  /** Creator's unpin, captured at creation. Call once on first exit; never a joiner's unpin. */
  readonly unpin: () => void;
}

/** One AssetStreamClient per (host, request) pair, refcounted. */
const sharedAssetSubscriptions = new Map<string, SharedAssetSubscription>();

/** Module-global refresh generation, never a per-hook counter. Starts at 1 so unrefreshed mounts stay at 0. */
let nextFocusRefreshGeneration = 1;

// eslint-disable-next-line max-params -- All six are semantically distinct and required for the shared-subscription identity + transport-pin contract (mirrors git-query-keys.ts's fileDiff).
function acquireSharedAssetSubscription(
  sharedKey: string,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  request: FileAssetRequest,
  callbacks: AssetStreamCallbacks,
  // Only consulted when THIS call creates a NEW entry (this caller becomes the creator) - a joiner's own pin/unpin are irrelevant, since the underlying session never uses the joiner's transport (Codex re-review, see `SharedAssetSubscription.unpin`'s doc comment for the full "why").
  pin: () => void,
  unpin: () => void,
): {
  readonly release: () => void;
  readonly retainedHeader: AssetStreamHeader | null;
} {
  let entry = sharedAssetSubscriptions.get(sharedKey);
  if (entry === undefined) {
    // The underlying AssetStreamClient about to open is opened THROUGH `wsStreamClient` - pin its owning hook's transport now, since this entry (and any future joiner) may need it to outlive THIS hook instance's own unmount.
    pin();
    const headerBox: { current: AssetStreamHeader | null } = {
      current: null,
    };
    const headerListeners = new Set<(header: AssetStreamHeader) => void>();
    const readyListeners = new Set<
      (header: AssetStreamHeader, bytes: Uint8Array) => void
    >();
    const failureListeners = new Set<(failure: AssetStreamFailure) => void>();
    const client = openAssetStreamClient(wsStreamClient, request, {
      onHeader: (header) => {
        headerBox.current = header;
        for (const listener of headerListeners) listener(header);
      },
      onReady: (header, bytes) => {
        sharedAssetSubscriptions.delete(sharedKey);
        unpin();
        for (const listener of readyListeners) listener(header, bytes);
      },
      onFailure: (failure) => {
        sharedAssetSubscriptions.delete(sharedKey);
        unpin();
        // Over-cap telemetry (PDF product decision, Q6): the 20 MiB cap is accepted for v1 on the strength of "Open Externally covers it" - this event is the evidence stream for revisiting that (range streaming / a per-type cap) if real users hit the wall.
        if (
          isPdfAssetPath(renderPathFor(request)) &&
          failure.reason === "too-large"
        ) {
          Analytics.getInstance().track(AnalyticsEvent.PdfPreviewTooLarge, {
            surface: assetSourceFor(request),
          });
        }
        for (const listener of failureListeners) listener(failure);
      },
    });
    entry = {
      client,
      refCount: 0,
      headerBox,
      headerListeners,
      readyListeners,
      failureListeners,
      unpin,
    };
    sharedAssetSubscriptions.set(sharedKey, entry);
  }
  const capturedEntry = entry;
  capturedEntry.refCount += 1;
  capturedEntry.headerListeners.add(callbacks.onHeader);
  capturedEntry.readyListeners.add(callbacks.onReady);
  capturedEntry.failureListeners.add(callbacks.onFailure);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      capturedEntry.headerListeners.delete(callbacks.onHeader);
      capturedEntry.readyListeners.delete(callbacks.onReady);
      capturedEntry.failureListeners.delete(callbacks.onFailure);
      capturedEntry.refCount -= 1;
      if (
        capturedEntry.refCount <= 0 &&
        sharedAssetSubscriptions.get(sharedKey) === capturedEntry
      ) {
        sharedAssetSubscriptions.delete(sharedKey);
        capturedEntry.client.close();
        capturedEntry.unpin();
      }
    },
    retainedHeader: capturedEntry.headerBox.current,
  };
}

/** Tab-scoped asset stream, never the renderer-default host. Depend on requestKeyFor(request), not the fresh request literal. */
export function useFileAsset(
  request: FileAssetRequest | null,
): UseFileAssetResult {
  const hostId = useTabHostId();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  // The full binding, not just its `.client` (Codex re-review) - the shared
  // subscription coalescing layer needs `pin`/`unpin` too, see
  // `acquireSharedAssetSubscription`'s call site below.
  const streamBinding = useHostStreamClientBindingFor(target, auth);
  const paneFocused = usePaneFocused();

  const requestKey = request === null ? null : requestKeyFor(request);
  const latestRequestRef = useRef(request);
  useEffect(() => {
    latestRequestRef.current = request;
  });
  const isWorktreeBacked = request !== null && isWorktreeBackedRequest(request);
  const renderKind: FileAssetRenderKind =
    request !== null && isPdfAssetPath(renderPathFor(request))
      ? "document"
      : "image";

  // An immutable git-object request never bumps it - refetching would only re-confirm the same OID.
  // Claims the NEXT MODULE-GLOBAL value (sol final-delta re-review), never a per-hook local increment - see `nextFocusRefreshGeneration`'s own comment for why a local counter is wrong here: two different hooks' independent refresh events must never land on the same generation by coincidence.
  const wasFocusedRef = useRef(paneFocused);
  const [focusRefreshGeneration, setFocusRefreshGeneration] = useState(0);
  useEffect(() => {
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = paneFocused;
    if (paneFocused && !wasFocused && isWorktreeBacked) {
      setFocusRefreshGeneration(nextFocusRefreshGeneration++);
    }
  }, [paneFocused, isWorktreeBacked]);

  // Render-time derived state, mirroring `useImageBlobUrlState`: only stream callbacks (genuinely async - fired later, in response to WS events) ever call `setResolved`.
  const [resolved, setResolved] = useState<{
    readonly key: string;
    readonly state: FileAssetState;
  } | null>(null);

  // Lets `reportDecodeFailure` reach the CURRENT fetch cycle's cache key and act safely regardless of mount state.
  // `isMountedRef`/`requestKeyRef` are shared across invocations by design (React guarantees the OLD effect's cleanup runs before the NEW one's setup, so they always reflect the LATEST invocation once its setup has run); `cacheKeyRef` likewise, but is only ever written from inside an `onHeader` that already checked ITS OWN invocation's local `active` flag, so a superseded invocation's late header can never clobber it with a stale key.
  const isMountedRef = useRef(false);
  const cacheKeyRef = useRef<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);

  // Mirrors `latestRequestRef` above: a bare effect, not a render-time write (`react-hooks/refs` forbids mutating a ref during render).
  const resolvedRef = useRef(resolved);
  useEffect(() => {
    resolvedRef.current = resolved;
  });

  // Close over this render's resolved. Ignore the error unless resolvedRef still is that object and resolved.key matches requestKeyRef.
  const reportDecodeFailure = useCallback((): void => {
    if (
      resolved === null ||
      resolvedRef.current !== resolved ||
      resolved.key !== requestKeyRef.current
    ) {
      return;
    }
    const cacheKey = cacheKeyRef.current;
    if (cacheKey !== null) {
      imageBlobCache.discard(FILE_ASSET_SCOPE_KEY, cacheKey);
    }
    if (!isMountedRef.current) return;
    setResolved({
      key: resolved.key,
      state: {
        status: "fallback",
        url: null,
        meta: null,
        reason: DECODE_FAILURE_REASONS[renderKind],
        totalBytes: null,
        servedFromCache: false,
      },
    });
  }, [resolved, renderKind]);

  useEffect(() => {
    const normalizedRequest = latestRequestRef.current;
    if (normalizedRequest === null || streamBinding === null) {
      isMountedRef.current = false;
      cacheKeyRef.current = null;
      requestKeyRef.current = null;
      return;
    }
    const requestKey = requestKeyFor(normalizedRequest);
    // Derived inside the effect from ITS request (not the component-scope
    // `renderKind`) so the closure can never pair a stale kind with a new
    // request's callbacks.
    const streamRenderKind: FileAssetRenderKind = isPdfAssetPath(
      renderPathFor(normalizedRequest),
    )
      ? "document"
      : "image";
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
    let sharedSubscription: { readonly release: () => void } | null = null;
    // Stays `null` on a cache hit, since the fetcher is then never invoked.
    let settleFetch: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
    let rejectFetch: ((error: Error) => void) | null = null;
    let usedForFetch = false;

    const callbacks: AssetStreamCallbacks = {
      onHeader: (header: AssetStreamHeader) => {
        if (!active) return;
        const meta: FileAssetMeta = {
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

        const key = buildFileAssetCacheKey({
          hostId,
          source: assetSourceFor(normalizedRequest),
          location: locationFor(normalizedRequest),
          filePath: normalizedRequest.filePath,
          contentIdentity: header.contentIdentity,
        });
        cacheKeyRef.current = key;

        const fetcher: ImageBytesFetcher = (_key, signal) => {
          usedForFetch = true;
          return new Promise<ImageBytesResult>((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("Image asset fetch was cancelled."));
              return;
            }
            // `mediaType: null` - no verdict to add.
            settleFetch = (bytes) => resolve({ bytes, mediaType: null });
            rejectFetch = reject;
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("Image asset fetch was cancelled."));
                // A spawning component's own unmount must not reach this: see the cleanup below.
                sharedSubscription?.release();
              },
              { once: true },
            );
          });
        };

        const lease = imageBlobCache.acquire(
          key,
          header.mediaType,
          // `key` is already the fully-scoped identity for this asset - it encodes hostId, source, location and path - so the namespace is all this adds, keeping asset entries disjoint from attachment ones.
          { scopeKey: FILE_ASSET_SCOPE_KEY, fetch: fetcher },
          retention,
        );
        releaseLease = lease.release;
        // usedForFetch is decided synchronously inside acquire. Release a losing consumer's share now, not after settle.
        if (!usedForFetch) sharedSubscription?.release();

        lease.promise.then(
          (resolution) => {
            if (!active) return;
            setResolved({
              key: requestKey,
              state: {
                status: "ready",
                url: resolution.url,
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
        // Copies into a fresh, real-`ArrayBuffer`-backed array rather than trusting the concatenated view's generic parameter, matching this codebase's established idiom at the same Uint8Array<ArrayBuffer> boundary (`useEpicImageFetcher`).
        settleFetch?.(new Uint8Array(bytes));
      },
      onFailure: (failure: AssetStreamFailure) => {
        // Over-cap telemetry lives in the shared entry's single failure path
        // (`acquireSharedAssetSubscription`), not here - this listener runs
        // once per mounted consumer of the same stream.
        if (rejectFetch !== null) {
          rejectFetch(new Error(describeFailure(failure, streamRenderKind)));
          return;
        }
        if (!active) return;
        setResolved({
          key: requestKey,
          state: {
            status: "fallback",
            url: null,
            meta: null,
            reason: describeFailure(failure, streamRenderKind),
            totalBytes: null,
            servedFromCache: false,
          },
        });
      },
    };

    const acquired = acquireSharedAssetSubscription(
      sharedSubscriptionKeyFor(
        hostId,
        normalizedRequest,
        focusRefreshGeneration,
      ),
      streamBinding.client,
      normalizedRequest,
      callbacks,
      streamBinding.pin,
      streamBinding.unpin,
    );
    sharedSubscription = acquired;
    // a second mount arriving after `assetHeader` but before settle) replays it HERE, never inside `acquireSharedAssetSubscription` itself - `sharedSubscription` must already be bound first, since `callbacks.onHeader` below can synchronously call `sharedSubscription.release()` (the loser-close path) and that call needs something to run against.
    if (acquired.retainedHeader !== null) {
      callbacks.onHeader(acquired.retainedHeader);
    }

    return () => {
      active = false;
      isMountedRef.current = false;
      // Owner subscription must outlive this unmount while siblings hold the lease. Non-owners release directly.
      if (!usedForFetch) sharedSubscription.release();
      releaseLease?.();
    };
  }, [requestKey, streamBinding, hostId, focusRefreshGeneration]);

  const state =
    resolved !== null && resolved.key === requestKey
      ? resolved.state
      : LOADING_STATE;
  return { ...state, reportDecodeFailure };
}
