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
      /**
       * Scopes pre-header subscription COALESCING ONLY (sol re-review) -
       * never `requestKeyFor` (a change here always accompanies a full
       * caller-side remount already, so no request ever needs to detect it
       * changing while staying mounted) or `buildImageAssetCacheKey` (whose
       * `contentIdentity` comes from the header itself and is already
       * revision-correct by construction). Without this, two independently
       * mounted requests for the identical (path, stage) at DIFFERENT
       * revisions - one remounting to a new revision while a separate,
       * still-mounted consumer keeps the old revision's pre-header
       * subscription alive - would coalesce onto each other and replay a
       * stale header across a genuine content change.
       */
      readonly coalesceRevision: string;
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
 * The pre-header shared-subscription coalescing map's key (sol re-review) -
 * `hostId` + `requestKeyFor` + a git request's `coalesceRevision` (absent
 * for a workspace request, which has no revision concept) + this hook's
 * current `focusRefreshGeneration`. Deliberately WIDER than `requestKeyFor`
 * alone: two requests that are otherwise identical but at different git
 * revisions, or different refresh generations, must never coalesce onto the
 * same in-flight stream, even though `requestKeyFor` treats them as the SAME
 * request (by design - neither is part of what decides whether a single
 * mount's own effect needs to re-run).
 *
 * The generation specifically closes a worktree-file gap (Codex re-review):
 * it is only ever an effect DEPENDENCY (triggers a worktree-backed request's
 * own refetch on refocus, decision #11), never part of the shared key before
 * this - so a second, still-focused pane's refocus-triggered "refresh" could
 * silently JOIN a first pane's older in-flight transfer instead of forcing a
 * fresh one, defeating the exact staleness signal it exists to send.
 *
 * MUST be `nextFocusRefreshGeneration`'s module-global value, never a
 * per-hook local counter (sol final-delta re-review): two DIFFERENT hooks'
 * local counters traverse the identical value sequence independently, so
 * pane A's first refocus and pane B's OWN first refocus - happening LATER,
 * while A's refreshed stream is still in flight - would both land on the
 * SAME local value and collide, letting B join A's already-refreshing (and
 * possibly stale-again) stream instead of forcing its own. A global
 * generation makes every refresh event's value unique across every hook,
 * for the life of the module, so two refresh events can never collide by
 * value regardless of which hook or when they fired.
 *
 * Canonicalized to `0` for a non-worktree-backed request (a git
 * session-retained side) REGARDLESS of what `focusRefreshGeneration`
 * currently holds - a hook whose `request` prop transitions from a
 * worktree-backed variant to a git one must not carry a stale, no-longer-
 * meaningful generation value into a request type that never refreshes at
 * all; only ever comparing `0` there also preserves the original
 * concurrent-first-mount coalescing for every non-worktree request.
 */
function sharedSubscriptionKeyFor(
  hostId: string,
  request: ImageAssetRequest,
  focusRefreshGeneration: number,
): string {
  return JSON.stringify([
    hostId,
    requestKeyFor(request),
    request.method === "git" ? request.coalesceRevision : null,
    isWorktreeBackedRequest(request) ? focusRefreshGeneration : 0,
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

function openAssetStreamClient(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  request: ImageAssetRequest,
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
  /**
   * The CREATOR's `HostStreamClientBinding.unpin` (Codex re-review) - `client`
   * above was opened through the creator's own transient transport, which
   * that transport's owning hook instance would otherwise close the moment
   * IT unmounts, regardless of whether a sibling that joined this entry is
   * still reading the stream through it. Captured once, at creation, and
   * called exactly once on whichever exit path actually fires first (settle,
   * in `onReady`/`onFailure`, or a zero-refcount `release()`) - never the
   * joiner's own unpin, which is irrelevant here since the underlying
   * session never used the joiner's transport at all.
   */
  readonly unpin: () => void;
}

/**
 * Coalesces concurrent requests for the SAME (host, request) pair into ONE
 * underlying `AssetStreamClient` (thermo re-review, ticket 09 follow-up):
 * the host reads and emits an entire asset synchronously in one call stack
 * the instant a stream opens, before any client-side close from a losing
 * consumer can land - so deduping only AFTER the fact (`imageBlobCache`'s
 * own post-header identity dedupe, or closing a redundant stream once
 * `usedForFetch` is known) still costs a second full host read for a
 * genuine concurrent-first-mount race. This map keys on the REQUEST tuple
 * itself, before any content identity is known - it composes with, not
 * replaces, `imageBlobCache`'s post-header dedupe (different layer, keyed
 * on `contentIdentity` instead): a genuine cache-miss race for the SAME
 * request now opens exactly one host-side stream, whose single set of
 * `assetHeader`/`assetChunk*`/`assetComplete` frames every joiner observes
 * through its own listener registration.
 *
 * Refcounted like `imageBlobCache`'s own lease, for the same reason: an
 * early-unmounting consumer must not strand its siblings still waiting on
 * the header/bytes. Deleted from the map the instant the underlying fetch
 * settles (`onReady`/`onFailure`) - once settled, a later mount goes
 * through the normal (post-header) `imageBlobCache` path instead, which
 * already handles that case correctly.
 *
 * A joiner can arrive in the window AFTER `assetHeader` already fired but
 * BEFORE settle (sol re-review, ticket 09 follow-up #2): the underlying
 * client only ever calls `onHeader` once, so a joiner registered after that
 * point would otherwise never see it - never acquiring its own
 * `imageBlobCache` lease, leaving it stuck at `"loading"` forever even
 * though the shared fetch completes normally. `headerBox` retains that one
 * header so `acquireSharedAssetSubscription` can hand it back to a late
 * joiner (via `retainedHeader`) to replay - the CALLER replays it, not this
 * function, so the replay only fires once the joiner's own `release` handle
 * is bound (a replay-triggered synchronous loser-close must have something
 * to call `release()` on).
 */
const sharedAssetSubscriptions = new Map<string, SharedAssetSubscription>();

/**
 * The NEXT value a refocus-triggered refresh will claim (sol final-delta
 * re-review) - module-global, not per-hook. A per-hook local counter looked
 * sufficient (two panes mounting concurrently both start at 0 and still
 * coalesce) but is actually WRONG: two DIFFERENT hooks' local counters
 * traverse the identical value sequence independently, so pane A's first
 * refocus (0->1) and pane B's OWN first refocus, happening later while A's
 * refreshed stream is still in flight, both land on "1" - a coincidental
 * value collision, not a shared generation. B would then join A's
 * (possibly already-stale-again) stream instead of forcing its own fresh
 * one. A global counter makes every refresh event's generation UNIQUE
 * across every hook, everywhere, for the life of the module - so two
 * refresh events can never collide by value regardless of which hook or
 * when they fired. Starts at 1 so an unrefreshed mount's `0` baseline is
 * never claimable by an actual refresh.
 */
let nextFocusRefreshGeneration = 1;

// eslint-disable-next-line max-params -- All six are semantically distinct and required for the shared-subscription identity + transport-pin contract (mirrors git-query-keys.ts's fileDiff).
function acquireSharedAssetSubscription(
  sharedKey: string,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  request: ImageAssetRequest,
  callbacks: AssetStreamCallbacks,
  // Only consulted when THIS call creates a NEW entry (this caller becomes
  // the creator) - a joiner's own pin/unpin are irrelevant, since the
  // underlying session never uses the joiner's transport (Codex re-review,
  // see `SharedAssetSubscription.unpin`'s doc comment for the full "why").
  pin: () => void,
  unpin: () => void,
): {
  readonly release: () => void;
  readonly retainedHeader: AssetStreamHeader | null;
} {
  let entry = sharedAssetSubscriptions.get(sharedKey);
  if (entry === undefined) {
    // The underlying AssetStreamClient about to open is opened THROUGH
    // `wsStreamClient` - pin its owning hook's transport now, since this
    // entry (and any future joiner) may need it to outlive THIS hook
    // instance's own unmount.
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

/**
 * Fetches one image asset - a workspace file or one side of a git-tracked
 * file - over the ticket-01 asset stream, surfacing the header before bytes
 * finish (for an aspect-ratio skeleton) and sharing the assembled bytes'
 * blob URL through the content-addressed `imageBlobCache`.
 *
 * Resolves the host transport from the CURRENT TAB (`useTabHostId` ->
 * `useHostStreamClientBindingFor`), never the renderer-default host - mirrors
 * `usePrDetailSubscription`'s tab-scoped stream pattern. Takes the full
 * binding, not just its `.client` - `pin`/`unpin` let the shared-subscription
 * coalescing layer keep a transport alive past ITS OWN unmount for as long
 * as a sibling still needs it (Codex re-review).
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

  // Re-stat on refocus (decision #11): only a worktree-backed request bumps
  // this on the pane's blurred->focused transition, so a still-mounted tile
  // reopens the stream and picks up an externally edited file. An immutable
  // git-object request never bumps it - refetching would only re-confirm the
  // same OID. Claims the NEXT MODULE-GLOBAL value (sol final-delta
  // re-review), never a per-hook local increment - see
  // `nextFocusRefreshGeneration`'s own comment for why a local counter is
  // wrong here: two different hooks' independent refresh events must never
  // land on the same generation by coincidence.
  const wasFocusedRef = useRef(paneFocused);
  const [focusRefreshGeneration, setFocusRefreshGeneration] = useState(0);
  useEffect(() => {
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = paneFocused;
    if (paneFocused && !wasFocused && isWorktreeBacked) {
      setFocusRefreshGeneration(nextFocusRefreshGeneration++);
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

  // Lets `reportDecodeFailure` reach the CURRENT fetch cycle's cache key and
  // act safely regardless of mount state. `isMountedRef`/`requestKeyRef` are
  // shared across invocations by design (React guarantees the OLD effect's
  // cleanup runs before the NEW one's setup, so they always reflect the
  // LATEST invocation once its setup has run); `cacheKeyRef` likewise, but
  // is only ever written from inside an `onHeader` that already checked
  // ITS OWN invocation's local `active` flag, so a superseded invocation's
  // late header can never clobber it with a stale key.
  const isMountedRef = useRef(false);
  const cacheKeyRef = useRef<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);

  // Tracks the LATEST `resolved`, read (not closed over) inside
  // `reportDecodeFailure` below to detect a STALE call. Mirrors
  // `latestRequestRef` above: a bare effect, not a render-time write
  // (`react-hooks/refs` forbids mutating a ref during render).
  const resolvedRef = useRef(resolved);
  useEffect(() => {
    resolvedRef.current = resolved;
  });

  // Recreated per `resolved` transition (CodeRabbit finding) - a decode
  // error is reported by a specific `<img>`, but this callback has no
  // parameter carrying which `url` failed, so it must instead close over
  // whatever `resolved` WAS when the render that handed this exact closure
  // to that `<img>` ran. If `resolvedRef.current` no longer points at that
  // SAME object by the time the (possibly late/async) decode-error event
  // fires, a NEWER resolution of the SAME request has since landed -
  // discarding `cacheKeyRef`'s CURRENT entry or overwriting `resolved` with
  // `fallback` would clobber that newer, perfectly valid ready state
  // instead of the stale one that actually failed to decode.
  //
  // Object identity alone isn't enough (sol re-review): switching from
  // request A to request B does NOT reset `resolved` - it stays A's stale
  // object (render-time key comparison only hides it behind
  // `LOADING_STATE`) until B's own callbacks eventually call `setResolved`.
  // A's captured `resolved` therefore still equals `resolvedRef.current` in
  // that window, even though `requestKeyRef.current` has ALREADY moved to
  // B (set synchronously at the start of B's fetch effect). Requiring
  // `resolved.key === requestKeyRef.current` too closes that gap: a late A
  // decode error now correctly bails out while B is still loading, instead
  // of writing `fallback` under B's key or discarding B's cache entry.
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
      imageBlobCache.discard(cacheKey);
    }
    if (!isMountedRef.current) return;
    setResolved({
      key: resolved.key,
      state: {
        status: "fallback",
        url: null,
        meta: null,
        reason: DECODE_FAILURE_REASON,
        totalBytes: null,
        servedFromCache: false,
      },
    });
  }, [resolved]);

  useEffect(() => {
    const normalizedRequest = latestRequestRef.current;
    if (normalizedRequest === null || streamBinding === null) {
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
    let sharedSubscription: { readonly release: () => void } | null = null;
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
                sharedSubscription?.release();
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
        // losing consumer's own share of the (possibly shared) subscription
        // is therefore redundant right now, not only once the shared lease
        // resolves - releasing it here instead of in the `.then()` below
        // stops the host from reading/enqueuing the same bytes twice for
        // the full duration of the owner's transfer, for the CONTENT-
        // identity race this fix 5 catches (imageBlobCache's own post-
        // header dedupe). The request-identity race (two concurrent first
        // mounts of the identical request, never reaching this branch since
        // neither is ever a "loser" pre-header) is caught earlier, by
        // `acquireSharedAssetSubscription` itself never opening a second
        // stream in the first place.
        if (!usedForFetch) sharedSubscription?.release();

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
    // A late joiner (the shared entry already has a header, e.g. a second
    // mount arriving after `assetHeader` but before settle) replays it HERE,
    // never inside `acquireSharedAssetSubscription` itself - `sharedSubscription`
    // must already be bound first, since `callbacks.onHeader` below can
    // synchronously call `sharedSubscription.release()` (the loser-close
    // path) and that call needs something to run against.
    if (acquired.retainedHeader !== null) {
      callbacks.onHeader(acquired.retainedHeader);
    }

    return () => {
      active = false;
      isMountedRef.current = false;
      // If this fetch is the shared cache entry's OWNER (`usedForFetch`),
      // its subscription share must outlive THIS unmount when other
      // consumers still hold a reference - releasing it here would strand
      // every sibling on the header skeleton forever, since only the
      // owner's `onReady` / `onFailure` ever settles the shared promise.
      // `releaseLease()` below is what may still release it, via the
      // fetcher's abort listener, but only once the LAST reference to the
      // SAME entry this lease was issued against drops - never a same-hash
      // entry that replaced it (a `discard()`, e.g. `reportDecodeFailure`,
      // in between). A fetch that never became the owner (never reached
      // `onHeader`, or lost the cache race) has no such shared
      // responsibility - nothing else will ever release it, so it must be
      // released directly.
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
