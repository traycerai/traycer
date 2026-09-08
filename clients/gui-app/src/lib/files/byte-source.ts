/**
 * `FileByteSource` + `useFileBytes` - the byte half of the unified file
 * rendering core (D27).
 *
 * ## What this is
 *
 * Four byte CONTRACTS already exist in this app, one per place a renderable
 * file can come from: a workspace path, a git object side, a chat attachment
 * hash, and - new with the epic media pipeline - an epic-file manifest entry.
 * Each has its own transport, its own authorization subject and its own
 * failure vocabulary. `useFileBytes` is the one seam a viewer talks to, so a
 * viewer never learns which of the four it is rendering.
 *
 * ## What this is NOT
 *
 * A second blob cache. `image-blob-cache.ts` is mime-agnostic, refcounted and
 * already serves PDF; every blob-delivered arm here goes through it (via
 * `useImageBlobUrlState`, which owns the retry ladder and the grace window).
 *
 * ## Delivery (D10)
 *
 * `delivery: "url"` hands a short-lived signed (or loopback) URL STRAIGHT to
 * an `<img>`/`<video>`, which is the only way range requests, seeking and a
 * 512 MiB clip work at all. It is returned only for sniffed image/video types.
 * `delivery: "blob"` means `src` is a `blob:` URL this client owns. A consumer
 * must never put a `"url"` src in an `<iframe>` or an `<a href>`: those are the
 * two places a non-image/video cloud origin becomes attacker-authored content
 * on a shared storage host, which is exactly what the blob leg exists to stop.
 */
import { useCallback, useEffect, useMemo } from "react";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EpicFileUnavailableReason,
  ReadEpicFileResponse,
} from "@traycer/protocol/host/epic/files";

import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  useFileAsset,
  type FileAssetRequest,
  type UseFileAssetResult,
} from "@/hooks/assets/use-file-asset";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  imageBlobCache,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import {
  useImageBlobUrlState,
  type ImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";
import {
  useChatAttachmentBlobSrc,
  type AttachmentBlobSrcState,
} from "@/lib/attachments/use-attachment-blob-src";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import type { HostRpcRegistry } from "@/lib/host";
import {
  familyAcceptsDirectUrl,
  mediaTypeFamily,
  type ViewerFamily,
} from "@/lib/files/media-type-family";

/**
 * A file whose bytes live in the workspace on the tab's host, addressed by the
 * workspace root plus a relative path. Mirrors `FileAssetRequest`'s workspace
 * arm field for field, because that arm IS this contract's transport.
 */
export interface WorkspacePathByteSource {
  readonly kind: "workspace-path";
  readonly workspacePath: string;
  readonly filePath: string;
}

/** One side of a git-tracked file - immutable by OID except the unstaged worktree position. */
export interface GitObjectByteSource {
  readonly kind: "git-object";
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly side: "old" | "new";
  readonly stage: "staged" | "unstaged";
  /** Scopes pre-header subscription coalescing only; see `use-file-asset.ts`. */
  readonly coalesceRevision: string;
}

/**
 * A content-addressed chat attachment. `mediaType` is the message model's
 * CLAIM and only a default - the serving host sniffs the delivered bytes and
 * its verdict is what ends up in {@link FileBytesState.mediaType}.
 */
export interface ChatAttachmentByteSource {
  readonly kind: "chat-attachment";
  readonly hash: string;
  readonly mediaType: string;
}

/**
 * One epic-file manifest entry. `path` and `sha256` travel together because
 * objects are immutable and content-addressed: overwriting a path mints a new
 * object, so a bare path would race that move.
 *
 * `mediaType` is the manifest's sniffed value, used until the host answers with
 * its own (the `url` arm carries the exact `Content-Type` the server will send).
 */
export interface EpicFileByteSource {
  readonly kind: "epic-file";
  readonly epicId: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
}

export type FileByteSource =
  | WorkspacePathByteSource
  | GitObjectByteSource
  | ChatAttachmentByteSource
  | EpicFileByteSource;

export type FileByteSourceKind = FileByteSource["kind"];

/** How `src` must be consumed. See the delivery note at the top of this file. */
export type FileBytesDelivery = "blob" | "url";

/**
 * Why bytes are not obtainable, as a settled state rather than an error.
 *
 * The four protocol reasons plus one this client adds: `fetch-failed`.
 */
export type FileBytesUnavailableReason =
  | EpicFileUnavailableReason
  | "fetch-failed";

/**
 * What the producing side already knows about the bytes before (or without)
 * decoding them: the asset stream's header carries all three, the epic-file
 * plane carries none (`epic.readFile` answers with an ADDRESS, so dimensions
 * are simply not on the wire), and a chat attachment carries none either.
 *
 * Every field is independently nullable because the legs disagree about which
 * they know: a dimension-less SVG has a size and no dimensions, and a settled
 * failure that arrived after the header has a size and nothing else.
 */
export interface FileBytesHeader {
  readonly width: number | null;
  readonly height: number | null;
  readonly sizeBytes: number | null;
}

/**
 * `reason` stays MACHINE-readable (the protocol enum) on every arm; the
 * human one-liner a placeholder renders lives in `message`, because the two
 * are different vocabularies and collapsing them into one field would widen
 * `reason` to `string` and cost `epic-file-tile.tsx` its exhaustive switch
 * over the four protocol reasons.
 */
export type FileBytesState =
  | {
      readonly status: "loading";
      readonly src: null;
      readonly mediaType: null;
      readonly delivery: null;
      readonly reason: null;
      /**
       * Non-null while the bytes are still arriving but their header already
       * landed - the asset stream's own `header` phase, which is what lets a
       * viewer hold an aspect-ratio skeleton instead of a spinner. The other
       * legs never reach it, so they stay `null` here.
       */
      readonly header: FileBytesHeader | null;
      readonly servedFromCache: false;
      readonly message: null;
    }
  | {
      readonly status: "ready";
      readonly src: string;
      readonly mediaType: string;
      readonly delivery: FileBytesDelivery;
      readonly reason: null;
      readonly header: FileBytesHeader | null;
      /**
       * Whether `src` resolved from the shared blob cache rather than a fresh
       * transfer. A brand-new `<img>` mounted over already-resident bytes
       * still reports `complete === false` at layout time, so this is the only
       * signal a viewer has for "skip the entrance fade". `false` on any leg
       * whose transport cannot tell (epic-file, chat attachment).
       */
      readonly servedFromCache: boolean;
      readonly message: null;
    }
  | {
      readonly status: "unavailable";
      readonly src: null;
      readonly mediaType: null;
      readonly delivery: null;
      /** `null` when the source's own transport gave no machine-readable one. */
      readonly reason: FileBytesUnavailableReason | null;
      /** Whatever the header had said before the failure - a size for a placeholder. */
      readonly header: FileBytesHeader | null;
      readonly servedFromCache: false;
      /** Human copy where the leg has one (the asset stream's per-render-kind message). */
      readonly message: string | null;
    }
  | {
      /** The tab's host predates this byte plane entirely - hide the surface, do not degrade it. */
      readonly status: "unsupported";
      readonly src: null;
      readonly mediaType: null;
      readonly delivery: null;
      readonly reason: null;
      readonly header: null;
      readonly servedFromCache: false;
      readonly message: null;
    };

/**
 * What {@link useFileBytes} returns: the settled state plus the one callback a
 * viewer needs that no state field can carry.
 */
export type UseFileBytesResult = FileBytesState & {
  /**
   * Call from an `<img onError>` (or a viewer's equivalent) once
   * `status === "ready"`: bytes that were valid enough to reach a blob URL can
   * still fail to DECODE in the browser, and the cache entry behind them must
   * be discarded or every later mount is handed the same undecodable URL.
   * A no-op on a leg with no cache entry of its own to invalidate.
   */
  readonly reportDecodeFailure: () => void;
};

const LOADING: FileBytesState = {
  status: "loading",
  src: null,
  mediaType: null,
  delivery: null,
  reason: null,
  header: null,
  servedFromCache: false,
  message: null,
};

const UNSUPPORTED: FileBytesState = {
  status: "unsupported",
  src: null,
  mediaType: null,
  delivery: null,
  reason: null,
  header: null,
  servedFromCache: false,
  message: null,
};

function loadingWithHeader(header: FileBytesHeader | null): FileBytesState {
  return header === null
    ? LOADING
    : {
        status: "loading",
        src: null,
        mediaType: null,
        delivery: null,
        reason: null,
        header,
        servedFromCache: false,
        message: null,
      };
}

function unavailable(
  reason: FileBytesUnavailableReason | null,
  message: string | null,
  header: FileBytesHeader | null,
): FileBytesState {
  return {
    status: "unavailable",
    src: null,
    mediaType: null,
    delivery: null,
    reason,
    header,
    servedFromCache: false,
    message,
  };
}

interface ReadyBytes {
  readonly src: string;
  readonly mediaType: string;
  readonly delivery: FileBytesDelivery;
  readonly header: FileBytesHeader | null;
  readonly servedFromCache: boolean;
}

function ready(args: ReadyBytes): FileBytesState {
  return {
    status: "ready",
    src: args.src,
    mediaType: args.mediaType,
    delivery: args.delivery,
    reason: null,
    header: args.header,
    servedFromCache: args.servedFromCache,
    message: null,
  };
}


/**
 * Host BUILDS that answered `E_HOST_UNSUPPORTED` for `epic.readFile`, keyed on
 * `(hostId, version)` - the same memo the chat attachment fetcher keeps, for
 * the same two reasons. Per BUILD because the answer is a property of the host
 * binary's negotiated method set, so a Files list would otherwise rebuild the
 * same rejection once per row to re-learn a constant; the VERSION is in the key
 * because Traycer can activate a newer build under the same `hostId` with no
 * renderer reload, and keyed on the id alone that upgrade would stay degraded
 * for the session.
 */
const hostBuildsWithoutEpicFileRead = new Set<string>();

/**
 * Test-only: forgets every remembered verdict. The set is module-global and
 * deliberately session-lived, so a test that exercises the unsupported path
 * would otherwise poison every later test in the same file.
 */
export function resetEpicFileHostSupportForTests(): void {
  hostBuildsWithoutEpicFileRead.clear();
}

/**
 * `null` when the verdict must not be remembered at all: an unresolved version
 * would collapse every unknown build into one bucket and let a single probe pin
 * a permanent negative that no upgrade clears. JSON-encoded rather than joined,
 * because both halves cross the wire as unconstrained strings.
 */
function epicFileHostBuildKey(
  hostId: string,
  hostVersion: string | null,
): string | null {
  return hostVersion === null ? null : JSON.stringify([hostId, hostVersion]);
}

/** The blob cache subject a fetched epic file is keyed under - the epic is the authorization subject (D06), never the sha alone. */
function epicFileScopeKey(
  hostId: string,
  epicId: string,
  path: string,
): string {
  return JSON.stringify(["epic-file", hostId, epicId, path]);
}

/** The one PERMANENT `epic.readFile` failure: this host has no file plane. */
function isHostUnsupportedError(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

/**
 * A host predating the file plane answers the declared `E_HOST_UNSUPPORTED`,
 * which is PERMANENT - retrying it doubles a doomed request per row.
 * `epic.readFile` is a `poll: null` method, so `useHostQuery` injects no
 * `retry: false` of its own.
 */
function retryEpicFileRead(failureCount: number, error: HostRpcError): boolean {
  return error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2;
}

/**
 * The blob leg's fetcher, built OUTSIDE the hook on purpose: an async closure
 * that captures hook-scope values reads to React Compiler as a dependency that
 * may be mutated later, which costs the surrounding component its memoization.
 * Built here, the hook's `useMemo` is a plain call on three primitives.
 */
function epicFileFetcher(
  scopeKey: string,
  blobUrl: string | null,
  blobMediaType: string,
): ScopedImageBytesFetcher {
  return {
    scopeKey,
    fetch: async (_subject: string, signal: AbortSignal) => {
      if (blobUrl === null) {
        throw new Error("No epic-file address to fetch");
      }
      const httpResponse = await globalThis.fetch(blobUrl, { signal });
      if (!httpResponse.ok) {
        // Throws rather than resolving to "unavailable": a 5xx or a dropped
        // socket is one good request away, and the blob cache's retry ladder
        // is what makes that recoverable.
        throw new Error(`Epic file read failed (${httpResponse.status})`);
      }
      const buffer = await httpResponse.arrayBuffer();
      return { bytes: new Uint8Array(buffer), mediaType: blobMediaType };
    },
  };
}

/**
 * Resolves one epic-file entry's bytes through `epic.readFile` on the TAB host
 * (bytes always follow the tile's bound host), declaring this client's
 * co-location vantage so the host can pick the loopback plane when it applies.
 *
 * `source === null` makes every leg inert: this hook is called unconditionally
 * from `useFileBytes` for every source kind, which is what keeps the hook order
 * stable across a source change.
 */
function useEpicFileBytes(source: EpicFileByteSource | null): FileBytesState {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  const hostVersion = useHostDirectoryEntry(hostId)?.version ?? null;
  // The client's declared vantage: which host it believes it shares a machine
  // with, `null` for "none I can name". A PLACEMENT FACT, never an
  // authorization - a wrong value costs a signed url instead of a loopback one.
  const coLocatedHostId = useReactiveLocalHostId();

  const buildKey = epicFileHostBuildKey(hostId, hostVersion);
  const knownUnsupported =
    buildKey !== null && hostBuildsWithoutEpicFileRead.has(buildKey);

  // Plain ternaries, not `source?.x ?? ""`: an inert mount still needs a
  // stable empty key, and the shorter form costs a branch each.
  const epicId = source === null ? "" : source.epicId;
  const path = source === null ? "" : source.path;
  const sha256 = source === null ? "" : source.sha256;
  const declaredMediaType = source === null ? "" : source.mediaType;

  const params = useMemo(
    () => ({ epicId, path, sha256, coLocatedHostId }),
    [epicId, path, sha256, coLocatedHostId],
  );

  const query = useHostQuery<HostRpcRegistry, "epic.readFile">({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.readFile",
    params,
    options: {
      enabled: source !== null && !knownUnsupported,
      // ponytail: zero, so every mount re-reads rather than handing an `<img>`
      // a signed url that expired while the tile was closed. It does NOT cover
      // a url expiring under a tile that stayed open - that needs a refresh
      // armed at `expiresAt`, which belongs with the video viewer (ticket 16)
      // that is the first consumer able to notice.
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: retryEpicFileRead,
    },
  });

  const isUnsupportedAnswer = isHostUnsupportedError(query.error);
  useEffect(() => {
    // External cache write, not derived state: the verdict outlives this hook
    // so a sibling row never re-probes a build already known to lack the plane.
    if (isUnsupportedAnswer && buildKey !== null) {
      hostBuildsWithoutEpicFileRead.add(buildKey);
    }
  }, [isUnsupportedAnswer, buildKey]);

  const response: ReadEpicFileResponse | null = query.data ?? null;
  const address = addressFor(response, declaredMediaType);

  // The blob leg. `url` is non-null only for an address whose family does NOT
  // take a direct url, so an image/video signed url is never run through
  // `fetch()` - the element owns its own range requests (D10).
  const blobUrl =
    address !== null && !familyAcceptsDirectUrl(address.family)
      ? address.url
      : null;
  const blobMediaType = address?.mediaType ?? "application/octet-stream";
  const scopeKey = epicFileScopeKey(hostId, epicId, path);
  const fetcher = useMemo<ScopedImageBytesFetcher>(
    () => epicFileFetcher(scopeKey, blobUrl, blobMediaType),
    [scopeKey, blobUrl, blobMediaType],
  );
  const blob = useImageBlobUrlState(
    blobUrl === null ? null : sha256,
    blobMediaType,
    fetcher,
    null,
  );

  return epicFileStateFor({
    unsupported: knownUnsupported || isUnsupportedAnswer,
    hasSource: source !== null,
    response,
    declaredMediaType,
    blob,
  });
}

/**
 * The `epic.readFile` answer, plus the blob leg's own state, folded into one
 * settled value. A pure function rather than a tail of branches inside the hook
 * so the whole decision - including the two arms that are NOT addresses - can
 * be read (and tested) without a renderer.
 */
function epicFileStateFor(args: {
  readonly unsupported: boolean;
  readonly hasSource: boolean;
  readonly response: ReadEpicFileResponse | null;
  readonly declaredMediaType: string;
  readonly blob: ImageBlobUrlState;
}): FileBytesState {
  if (args.unsupported) return UNSUPPORTED;
  if (!args.hasSource || args.response === null) return LOADING;
  if (args.response.kind === "unavailable") {
    // No header and no human copy: `epic.readFile` answers with an address
    // and a machine reason, and dimensions are not on the wire (D27/D10).
    return unavailable(args.response.reason, null, null);
  }
  // Re-derived here rather than handed in: the hook's own `address` feeds the
  // blob leg's `useMemo`, and passing that same object on to a call AFTER the
  // memo is what React Compiler reads as "this dependency may be mutated
  // later" - which costs the hook its memoization. `addressFor` is pure and
  // cheap, so the second call buys the memo back.
  const address = addressFor(args.response, args.declaredMediaType);
  if (address === null) return LOADING;
  if (familyAcceptsDirectUrl(address.family)) {
    return ready({
      src: address.url,
      mediaType: address.mediaType,
      delivery: "url",
      header: null,
      servedFromCache: false,
    });
  }
  if (args.blob.status === "ready") {
    return ready({
      src: args.blob.url,
      mediaType: args.blob.mediaType,
      delivery: "blob",
      header: null,
      servedFromCache: false,
    });
  }
  return args.blob.status === "unavailable"
    ? unavailable("fetch-failed", null, null)
    : LOADING;
}

interface EpicFileAddress {
  readonly url: string;
  readonly mediaType: string;
  readonly family: ViewerFamily;
}

/**
 * The addressable arms of a `readFile` answer, with the media type that decides
 * delivery. The `url` arm's own `mediaType` wins over the manifest's: it is the
 * exact `Content-Type` the server will send, so a client that used the
 * manifest's value could hand an `<img>` bytes the origin labels otherwise.
 */
function addressFor(
  response: ReadEpicFileResponse | null,
  declaredMediaType: string,
): EpicFileAddress | null {
  if (response === null) return null;
  if (response.kind === "url") {
    return {
      url: response.url,
      mediaType: response.mediaType,
      family: mediaTypeFamily(response.mediaType),
    };
  }
  if (response.kind === "loopback") {
    return {
      url: response.url,
      mediaType: declaredMediaType,
      family: mediaTypeFamily(declaredMediaType),
    };
  }
  return null;
}

/** The asset-stream request for the two arms it serves, `null` for the rest. */
function assetRequestFor(source: FileByteSource): FileAssetRequest | null {
  if (source.kind === "workspace-path") {
    return {
      method: "workspace",
      workspacePath: source.workspacePath,
      filePath: source.filePath,
    };
  }
  if (source.kind === "git-object") {
    return {
      method: "git",
      runningDir: source.runningDir,
      filePath: source.filePath,
      previousPath: source.previousPath,
      side: source.side,
      stage: source.stage,
      coalesceRevision: source.coalesceRevision,
    };
  }
  return null;
}

/**
 * One file's bytes, whichever of the four contracts it comes from.
 *
 * Every leg is mounted on every render - `useFileAsset(null)`,
 * `useChatAttachmentBlobSrc(null, ...)` and `useEpicFileBytes(null)` are all
 * inert by contract - because a source can change kind under a single mount
 * (a tile rebound, a diff side swapped) and the hook order may not.
 *
 * `source === null` is the same rule one level up: a surface that renders an
 * OPTIONAL companion file - a recording's poster, which exists only once the
 * host has written its manifest entry - still has to call this on every
 * render. It settles as `loading`, which is what "no source named yet"
 * already means here; such a caller decides on the entry it looked up, never
 * on this state, so nothing renders a spinner that can never end.
 *
 * Bytes for the workspace/git and epic-file legs are fetched through the TAB
 * host, never the app-active one; those legs go inert when there is no
 * `<TabHostProvider>` above the caller, so a provider-less surface (a chat
 * transcript rendering an attachment) degrades rather than throwing.
 */
export function useFileBytes(source: FileByteSource | null): UseFileBytesResult {
  const asset = useFileAsset(source === null ? null : assetRequestFor(source));
  const attachmentHash =
    source?.kind === "chat-attachment" ? source.hash : null;
  const attachment = useChatAttachmentBlobSrc(
    attachmentHash,
    source?.kind === "chat-attachment" ? source.mediaType : "",
    null,
  );
  // The chat leg's own cache subject, so a decode failure can discard the
  // exact entry the blob resolved from. Read here rather than through
  // `useChatAttachmentBlobSrc` (which does not surface it) - the hook is
  // referentially stable per (handle, scope), so the second call is free.
  const attachmentFetcher = useChatImageFetcher();
  const attachmentScopeKey = attachmentFetcher.scopeKey;
  const discardAttachmentBlob = useCallback((): void => {
    if (attachmentHash === null) return;
    imageBlobCache.discard(attachmentScopeKey, attachmentHash);
  }, [attachmentScopeKey, attachmentHash]);
  const epicFile = useEpicFileBytes(
    source?.kind === "epic-file" ? source : null,
  );

  const state = fileBytesStateFor(source, asset, attachment, epicFile);
  if (source === null) return { ...state, reportDecodeFailure: NOOP };
  if (source.kind === "chat-attachment") {
    return { ...state, reportDecodeFailure: discardAttachmentBlob };
  }
  if (source.kind === "epic-file") {
    // Nothing to invalidate: an image/video epic file is delivered as a
    // direct url (D10) and never reaches the blob cache at all, and the
    // blob-delivered families have no decode step a viewer can report on.
    return { ...state, reportDecodeFailure: NOOP };
  }
  return { ...state, reportDecodeFailure: asset.reportDecodeFailure };
}

const NOOP = (): void => {};

/** Which leg answers, split out so `useFileBytes` is hooks plus one call. */
function fileBytesStateFor(
  source: FileByteSource | null,
  asset: UseFileAssetResult,
  attachment: AttachmentBlobSrcState,
  epicFile: FileBytesState,
): FileBytesState {
  if (source === null) return LOADING;
  if (source.kind === "epic-file") return epicFile;
  if (source.kind === "chat-attachment") {
    // No header, no cache signal and no human copy: the chat plane delivers
    // bytes with a sniffed type and nothing else.
    if (attachment.status === "ready") {
      return ready({
        src: attachment.src,
        mediaType: attachment.mediaType,
        delivery: "blob",
        header: null,
        servedFromCache: false,
      });
    }
    return attachment.status === "unavailable"
      ? unavailable(null, null, null)
      : LOADING;
  }
  return assetStateFor(asset);
}

/**
 * Whatever the asset stream has already declared about the bytes, at any of
 * its phases: `meta` once the header lands (and it carries the dimensions),
 * `totalBytes` alone on a failure that arrived after the header.
 */
function assetHeader(asset: UseFileAssetResult): FileBytesHeader | null {
  if (asset.meta !== null) {
    return {
      width: asset.meta.width,
      height: asset.meta.height,
      sizeBytes: asset.meta.sizeBytes,
    };
  }
  if (asset.totalBytes !== null) {
    return { width: null, height: null, sizeBytes: asset.totalBytes };
  }
  return null;
}

/** The asset stream's own settle, split out to keep `useFileBytes` readable. */
function assetStateFor(asset: UseFileAssetResult): FileBytesState {
  const header = assetHeader(asset);
  if (asset.status === "ready" && asset.url !== null && asset.meta !== null) {
    return ready({
      src: asset.url,
      mediaType: asset.meta.mediaType,
      delivery: "blob",
      header,
      servedFromCache: asset.servedFromCache,
    });
  }
  // `fallback` is the asset stream's settled failure. Its `reason` is human
  // copy (per render kind), which is why it lands on `message` rather than on
  // the machine-readable `reason` enum - the stream has no such enum to give.
  if (asset.status === "fallback") {
    return unavailable(null, asset.reason, header);
  }
  // The stream's `header` phase is a LOADING arm that already knows the
  // bytes' shape, which is exactly what an aspect-ratio skeleton needs.
  return loadingWithHeader(header);
}
