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
import { useEffect, useMemo } from "react";

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
import type { ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import {
  useImageBlobUrlState,
  type ImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";
import { useChatAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
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

export type FileBytesState =
  | {
      readonly status: "loading";
      readonly src: null;
      readonly mediaType: null;
      readonly delivery: null;
      readonly reason: null;
    }
  | {
      readonly status: "ready";
      readonly src: string;
      readonly mediaType: string;
      readonly delivery: FileBytesDelivery;
      readonly reason: null;
    }
  | {
      readonly status: "unavailable";
      readonly src: null;
      readonly mediaType: null;
      readonly delivery: null;
      /** `null` when the source's own transport gave no machine-readable one. */
      readonly reason: FileBytesUnavailableReason | null;
    }
  | {
      /** The tab's host predates this byte plane entirely - hide the surface, do not degrade it. */
      readonly status: "unsupported";
      readonly src: null;
      readonly mediaType: null;
      readonly delivery: null;
      readonly reason: null;
    };

const LOADING: FileBytesState = {
  status: "loading",
  src: null,
  mediaType: null,
  delivery: null,
  reason: null,
};

const UNSUPPORTED: FileBytesState = {
  status: "unsupported",
  src: null,
  mediaType: null,
  delivery: null,
  reason: null,
};

function unavailable(
  reason: FileBytesUnavailableReason | null,
): FileBytesState {
  return {
    status: "unavailable",
    src: null,
    mediaType: null,
    delivery: null,
    reason,
  };
}

function ready(
  src: string,
  mediaType: string,
  delivery: FileBytesDelivery,
): FileBytesState {
  return { status: "ready", src, mediaType, delivery, reason: null };
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
    return unavailable(args.response.reason);
  }
  // Re-derived here rather than handed in: the hook's own `address` feeds the
  // blob leg's `useMemo`, and passing that same object on to a call AFTER the
  // memo is what React Compiler reads as "this dependency may be mutated
  // later" - which costs the hook its memoization. `addressFor` is pure and
  // cheap, so the second call buys the memo back.
  const address = addressFor(args.response, args.declaredMediaType);
  if (address === null) return LOADING;
  if (familyAcceptsDirectUrl(address.family)) {
    return ready(address.url, address.mediaType, "url");
  }
  if (args.blob.status === "ready") {
    return ready(args.blob.url, args.blob.mediaType, "blob");
  }
  return args.blob.status === "unavailable"
    ? unavailable("fetch-failed")
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
 * Must be called inside `<TabHostProvider>`: bytes are always fetched through
 * the TAB host, never the app-active one.
 */
export function useFileBytes(source: FileByteSource | null): FileBytesState {
  const asset = useFileAsset(source === null ? null : assetRequestFor(source));
  const attachment = useChatAttachmentBlobSrc(
    source?.kind === "chat-attachment" ? source.hash : null,
    source?.kind === "chat-attachment" ? source.mediaType : "",
    null,
  );
  const epicFile = useEpicFileBytes(
    source?.kind === "epic-file" ? source : null,
  );

  if (source === null) return LOADING;
  if (source.kind === "epic-file") return epicFile;
  if (source.kind === "chat-attachment") {
    if (attachment.status === "ready") {
      return ready(attachment.src, attachment.mediaType, "blob");
    }
    return attachment.status === "unavailable" ? unavailable(null) : LOADING;
  }
  return assetStateFor(asset);
}

/** The asset stream's own settle, split out to keep `useFileBytes` readable. */
function assetStateFor(asset: UseFileAssetResult): FileBytesState {
  if (asset.status === "ready" && asset.url !== null && asset.meta !== null) {
    return ready(asset.url, asset.meta.mediaType, "blob");
  }
  // `fallback` is the asset stream's settled failure; its `reason` is already
  // human copy (per-render-kind), which is why it is not mapped onto the
  // machine-readable enum above.
  return asset.status === "fallback" ? unavailable(null) : LOADING;
}
