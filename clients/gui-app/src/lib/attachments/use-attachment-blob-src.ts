import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { FetchArtifactAttachmentFound } from "@traycer/protocol/host/epic/artifact-attachment";

import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { useEpicSnapshotLoaded } from "@/lib/epic-selectors";
import {
  buildScopedImageCacheKey,
  type ImageBytesFetcher,
  type ImageBytesResult,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import { ARTIFACT_OBJECT_DOWNLOADING_POLL_LANE } from "@/lib/host-rpc-policy/host-method-policy-table";
import { waitUnlessAborted } from "@/lib/wait-unless-aborted";
import { persistTranscriptImageBytes } from "@/lib/attachments/transcript-image-bytes-store";
import {
  IMAGE_UNAVAILABLE_GRACE_MS,
  type ImageBlobUrlState,
  useImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import {
  useArtifactAttachmentScope,
  type ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readEpicAttachmentBytes,
  readHeldEpicAttachmentBytes,
} from "@/lib/epic-replica-reads";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

export type AttachmentBlobSrcState =
  | { readonly status: "loading"; readonly src: null }
  | { readonly status: "unavailable"; readonly src: null }
  | {
      readonly status: "ready";
      readonly src: string;
      /**
       * What `src` actually IS, as opposed to what the message model claimed.
       * For a resolved hash this is the blob's real type - the serving host
       * sniffs chat-attachment bytes and its verdict is authoritative - and
       * for an inline `dataUrl` it is the declared type, which is also the
       * type encoded in the URL itself. Render sites that gate on format
       * (SVG sanitization) must branch on this, never on the stored claim.
       */
      readonly mediaType: string;
    };

/**
 * Host BUILDS that have answered `E_HOST_UNSUPPORTED` for
 * `epic.fetchArtifactAttachment`, keyed on the `(hostId, version)` pair.
 *
 * The method is optional rather than floor, so a lane-capable host can still
 * predate it. Per build and not per image, for the reason the chat set spells
 * out: the answer is a property of the host binary's negotiated method set, and
 * re-deriving it per thumbnail would rebuild the same rejection to re-learn a
 * constant. The VERSION is in the key because a host can be upgraded in place
 * under the same id with no renderer reload; keyed on the id alone that upgrade
 * would stay degraded for the session.
 */
const hostBuildsWithoutArtifactAttachmentFetch = new Set<string>();
let artifactHostSupportGeneration = 0;

/**
 * Forgets every remembered `E_HOST_UNSUPPORTED` verdict. Host ids belong to
 * an account; identity teardown must not leave account A's probe pinning
 * account B's session.
 */
export function resetArtifactAttachmentHostSupport(): void {
  artifactHostSupportGeneration += 1;
  hostBuildsWithoutArtifactAttachmentFetch.clear();
}

/**
 * The key a verdict is remembered under, or `null` when it must not be
 * remembered at all - an unresolved version would collapse every unknown into
 * one bucket and let a single probe pin a permanent negative no upgrade clears.
 */
function artifactHostBuildKey(
  scope: ArtifactAttachmentScopeValue,
): string | null {
  if (scope.hostVersion === null) return null;
  // JSON-encoded, not newline-joined. The previous comment here asserted that
  // "a host id never contains one" - an assumption about a value that crosses
  // the wire as an unconstrained string, and it says nothing about
  // `hostVersion` at all. A newline in either aliases distinct pairs, so an
  // `E_HOST_UNSUPPORTED` verdict learned for one build would suppress
  // attachment fetches for a different one for the rest of the session.
  return JSON.stringify([scope.hostId, scope.hostVersion]);
}

/**
 * Download state for one scoped cache identity, kept only while a fetch marks
 * it or a rendered image observes it, so closed tasks and outgoing accounts
 * leave nothing behind.
 */
interface DownloadWatch {
  /**
   * Fetches currently marking it as downloading. A count, not a flag: a
   * discarded entry's fetch can still be unwinding when its replacement marks
   * the same identity, and its clear must not unmark the live one.
   */
  marks: number;
  /** Downloads that have ended while it was kept: each starts a fresh window. */
  ended: number;
  readonly listeners: Set<() => void>;
}

const downloadWatches = new Map<string, DownloadWatch>();

function downloadWatchOf(identity: string): DownloadWatch {
  const existing = downloadWatches.get(identity);
  if (existing !== undefined) return existing;
  const created: DownloadWatch = { marks: 0, ended: 0, listeners: new Set() };
  downloadWatches.set(identity, created);
  return created;
}

function dropIdleDownloadWatch(identity: string, watch: DownloadWatch): void {
  if (watch.marks > 0 || watch.listeners.size > 0) return;
  if (downloadWatches.get(identity) === watch) downloadWatches.delete(identity);
}

function notifyDownloadWatch(watch: DownloadWatch): void {
  for (const listener of [...watch.listeners]) listener();
}

function subscribeDownloadWatch(
  identity: string,
  onChange: () => void,
): () => void {
  const watch = downloadWatchOf(identity);
  watch.listeners.add(onChange);
  return () => {
    watch.listeners.delete(onChange);
    dropIdleDownloadWatch(identity, watch);
  };
}

/** Returns the clear; calling it more than once is a no-op. */
function markIdentityDownloading(identity: string): () => void {
  const watch = downloadWatchOf(identity);
  watch.marks += 1;
  if (watch.marks === 1) notifyDownloadWatch(watch);
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    watch.marks -= 1;
    if (watch.marks > 0) return;
    watch.ended += 1;
    notifyDownloadWatch(watch);
    dropIdleDownloadWatch(identity, watch);
  };
}

/**
 * Which grace window an image is in: `null` while its host is downloading the
 * bytes, else how many of its downloads have ended. A new value is a new
 * window.
 */
function graceWindowOf(identity: string): number | null {
  const watch = downloadWatches.get(identity);
  if (watch === undefined) return 0;
  return watch.marks > 0 ? null : watch.ended;
}

/**
 * Whether the current grace window for `identity` has run out. Kept apart from
 * the blob acquisition, so pausing and restarting the window never restarts
 * the fetch or its retry ladder.
 *
 * An expiry belongs to the window that recorded it and is dropped when that
 * window ends. A watch that was dropped and recreated starts counting again,
 * so a view that returns to an image would otherwise find its earlier expiry
 * matching the new window. The key check covers the render between a change
 * and the cleanup.
 */
function useGraceWindowExpired(
  identity: string | null,
  graceWindow: number | null,
): boolean {
  const [expired, setExpired] = useState<{
    readonly identity: string;
    readonly graceWindow: number;
  } | null>(null);
  useEffect(() => {
    if (identity === null || graceWindow === null) return;
    const timer = window.setTimeout(() => {
      setExpired({ identity, graceWindow });
    }, IMAGE_UNAVAILABLE_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
      setExpired(null);
    };
  }, [identity, graceWindow]);
  return (
    expired !== null &&
    expired.identity === identity &&
    expired.graceWindow === graceWindow
  );
}

function bytesFromFoundAttachment(
  hash: string,
  found: FetchArtifactAttachmentFound,
): ImageBytesResult {
  const bytes = base64ToBytes(found.bytesBase64);
  if (bytes === null) {
    // A malformed base64 body is a wire bug, not an absent image: throwing
    // keeps it retryable rather than caching a permanent unavailable.
    throw new Error(`Artifact attachment ${hash} had an undecodable body`);
  }
  return { bytes, mediaType: found.mediaType };
}

/**
 * The lane-arm leg: ask this artifact's host for one attachment's bytes.
 *
 * `null` for every "not obtainable here" answer - the host said `missing`, the
 * host predates the method, or there is no artifact scope / no reachable host -
 * so the caller can fall through. It THROWS for transient failures, which keeps
 * the image blob cache's retry ladder alive for bytes that are one publish
 * away.
 *
 * While the host answers `downloading`, it asks again on the downloading lane's
 * backoff inside this one call, so the wait spends none of the ladder's
 * attempts, and `identity` reads as downloading until the call settles.
 *
 * The response's `mediaType` rides along because it is host-authoritative,
 * derived from the delivered bytes' magic bytes rather than echoed from the
 * document-authored claim - and the SVG sanitization gate downstream keys on
 * whichever one reaches it.
 */
async function readArtifactAttachmentFromHost(
  scope: ArtifactAttachmentScopeValue | null,
  hash: string,
  identity: string,
  signal: AbortSignal,
): Promise<ImageBytesResult | null> {
  if (scope === null || scope.client === null) return null;
  const buildKey = artifactHostBuildKey(scope);
  if (
    buildKey !== null &&
    hostBuildsWithoutArtifactAttachmentFetch.has(buildKey)
  ) {
    return null;
  }
  const probeGeneration = artifactHostSupportGeneration;
  let clearDownloading: (() => void) | null = null;
  let delayMs = ARTIFACT_OBJECT_DOWNLOADING_POLL_LANE.initialDelayMs;
  try {
    for (;;) {
      const response = await scope.client.requestWithSignal(
        "epic.fetchArtifactAttachment",
        { epicId: scope.epicId, artifactId: scope.artifactId, hash },
        signal,
      );
      if (response.ok) return bytesFromFoundAttachment(hash, response);
      if (response.reason === "missing") return null;
      clearDownloading ??= markIdentityDownloading(identity);
      await waitUnlessAborted(delayMs, signal, "Image fetch was cancelled.");
      delayMs = Math.min(
        delayMs * 2,
        ARTIFACT_OBJECT_DOWNLOADING_POLL_LANE.maxDelayMs,
      );
    }
  } catch (error: unknown) {
    if (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED") {
      if (
        buildKey !== null &&
        !signal.aborted &&
        probeGeneration === artifactHostSupportGeneration
      ) {
        hostBuildsWithoutArtifactAttachmentFetch.add(buildKey);
      }
      return null;
    }
    throw error;
  } finally {
    clearDownloading?.();
  }
}

/**
 * The store surface the arm-abort lease needs: `installedArm` plus
 * `subscribe`. Held per handle, not per hook instance, so an arm change
 * still cancels a retained in-flight fetch after the last image unmounts.
 */
interface ArmAbortSource {
  readonly store: {
    readonly getState: () => { readonly installedArm?: string | null };
    readonly subscribe: (onStoreChange: () => void) => () => void;
  };
}

interface ArmAbortLease {
  arm: string | null;
  abort: AbortController;
  inFlight: number;
  unsubscribe: () => void;
}

const armAbortLeases = new Map<object, ArmAbortLease>();

function currentInstalledArm(handle: ArmAbortSource): string | null {
  return handle.store.getState().installedArm ?? null;
}

function acquireArmAbort(
  handle: ArmAbortSource,
  expectedArm: string | null,
): {
  readonly signal: AbortSignal;
  readonly release: () => void;
} {
  // Captured at render (`installedArm` on the fetch closure) vs read at
  // call/effect time. If they disagree, this fetch selected a byte source
  // the store no longer uses; abort so a later lanes fetch does not join
  // a parked waiting-replica read.
  if (currentInstalledArm(handle) !== expectedArm) {
    const abort = new AbortController();
    abort.abort();
    return { signal: abort.signal, release: () => {} };
  }
  let lease = armAbortLeases.get(handle);
  if (lease === undefined) {
    const created: ArmAbortLease = {
      arm: expectedArm,
      abort: new AbortController(),
      inFlight: 0,
      unsubscribe: () => {},
    };
    created.unsubscribe = handle.store.subscribe(() => {
      const live = armAbortLeases.get(handle);
      if (live === undefined) return;
      const nextArm = currentInstalledArm(handle);
      if (live.arm === nextArm) return;
      live.abort.abort();
      live.arm = nextArm;
      live.abort = new AbortController();
    });
    armAbortLeases.set(handle, created);
    lease = created;
  }
  lease.inFlight += 1;
  let released = false;
  return {
    signal: lease.abort.signal,
    release: () => {
      if (released) return;
      released = true;
      const live = armAbortLeases.get(handle);
      if (live === undefined) return;
      live.inFlight -= 1;
      if (live.inFlight > 0) return;
      live.unsubscribe();
      armAbortLeases.delete(handle);
    },
  };
}

/** Drop arm-abort leases so an outgoing epic handle cannot abort the next account. */
export function resetEpicImageFetcherArmAbort(): void {
  for (const lease of armAbortLeases.values()) {
    lease.unsubscribe();
    lease.abort.abort();
  }
  armAbortLeases.clear();
}

/**
 * The byte source for image attachments rendered inside an ARTIFACT body.
 *
 * Two legs, selected by the installed ARM rather than by trying both, because
 * the legacy leg's contract is a WAITING read and waiting is only correct where
 * the bytes can actually arrive:
 *
 * 1. **Lane arm** - `epic.fetchArtifactAttachment` on the artifact's host. Only
 *    the `@1` adapter ever emits on the root plane, so a lane-backed session's
 *    `attachments` map is never seeded and the waiting read below would park
 *    for the life of the session while the image rendered "unavailable". The
 *    host answers from wherever it holds the bytes, and says `downloading`
 *    while it is still fetching them. With no scope or a host that predates
 *    the method it falls back to whatever the replica already HOLDS - the
 *    non-waiting read, so an absent hash fails fast and stays retryable rather
 *    than parking on bytes no lane will deliver.
 * 2. **`@1`** - the waiting doc read, unchanged. An artifact is epic-shared by
 *    nature, so doc replication IS its access model there, and an image whose
 *    bytes are still replicating must resolve when they land rather than read
 *    as missing. Deliberately NOT routed through the host: this leg is
 *    byte-for-byte what every legacy session already did.
 *
 * Referentially stable per (handle, scope) so it can be fed to
 * `useImageBlobUrl` / `AttachmentStrip` without re-acquiring on render.
 */
export function useEpicImageFetcher(): ScopedImageBytesFetcher {
  const handle = useMaybeOpenEpicHandle();
  const scope = useArtifactAttachmentScope();
  const viewerUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const persistenceScopeKey = epicAttachmentScopeKey(handle, scope);
  // Persistence already partitions by account. The in-memory blob cache and
  // download progress must share a key that includes the viewer.
  const viewerScopeKey = JSON.stringify([persistenceScopeKey, viewerUserId]);
  // SUBSCRIBED, not read imperatively at call time. The arm decides which of
  // the two legs below runs, and the legacy leg's contract is to WAIT - so an
  // in-place host upgrade that swaps `@1` for `lanes` mid-read leaves that
  // wait parked on a root-document attachments map the lane arm never seeds.
  // Reading `getState()` inside the callback kept this hook referentially
  // stable across exactly that transition, so nothing re-acquired.
  const installedArm = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) =>
        handle === null ? () => {} : handle.store.subscribe(onStoreChange),
      [handle],
    ),
    useCallback(() => handle?.store.getState().installedArm ?? null, [handle]),
  );
  const fetch = useCallback<ImageBytesFetcher>(
    async (h, signal) => {
      if (handle === null) {
        throw new Error("No open-epic handle to fetch image attachment");
      }
      if (installedArm === "lanes") {
        const fromHost = await readArtifactAttachmentFromHost(
          scope,
          h,
          buildScopedImageCacheKey(viewerScopeKey, h),
          signal,
        );
        if (fromHost !== null) return fromHost;
        const held = await readHeldEpicAttachmentBytes(handle, h);
        if (held === null) {
          throw new Error(`Image attachment ${h} unavailable`);
        }
        return { bytes: new Uint8Array(held), mediaType: null };
      }
      // Through the replica-read seam rather than the store directly: this
      // is one of the byte reads that resolves against the worker-held root
      // replica once the runtime moves, and the seam is where that swap
      // happens. The WAITING variant deliberately - an artifact image whose
      // bytes are still replicating must resolve when they land, not read as
      // missing (see the seam for why the chat leg takes the other one).
      const bytes = await readEpicAttachmentBytes(handle, h, signal);
      if (bytes === null) {
        throw new Error(`Image attachment ${h} unavailable`);
      }
      // The doc replica stores raw bytes with no sniffed header of its own,
      // so it has no verdict to offer and the caller's declared type stands.
      return { bytes: new Uint8Array(bytes), mediaType: null };
    },
    [handle, scope, installedArm, viewerScopeKey],
  );
  return useMemo<ScopedImageBytesFetcher>(() => {
    const persisted = persistTranscriptImageBytes({
      scopeKey: persistenceScopeKey,
      fetch,
    });
    return {
      scopeKey: viewerScopeKey,
      fetch: async (hash, callerSignal) => {
        if (handle === null) {
          throw new Error("No open-epic handle to fetch image attachment");
        }
        // Subscribe on the handle store, not a mounted effect: last-ref
        // grace keeps the in-flight fetch after unmount, and an arm change
        // in that window must still drop the parked legacy read.
        const armAbort = acquireArmAbort(handle, installedArm);
        const composed = signalUntilArmChanges(callerSignal, armAbort.signal);
        try {
          return await persisted.fetch(hash, composed.signal);
        } finally {
          composed.clear();
          armAbort.release();
        }
      },
    };
  }, [handle, fetch, installedArm, persistenceScopeKey, viewerScopeKey]);
}

/**
 * What an artifact-plane byte read is authorized against, as a cache subject.
 *
 * Both legs are covered by one key, and the installed ARM is deliberately not
 * part of it. The lane leg proves `(epicId, artifactId)` to the host; the `@1`
 * leg reads the epic doc replica, where - as this file's own contract says -
 * "an artifact is epic-shared by nature, so doc replication IS its access
 * model". Those are different checks, and the lane one is the stricter, so the
 * case worth stating is a blob resolved under `@1` and then reused after an
 * in-place upgrade flips the arm: it skips a stricter check than the one it
 * passed. It discloses nothing even so, because the `@1` leg's bytes came out
 * of the epic document this client already holds locally - the reuse hands
 * back what the replica had already given the same user. Keying on the arm
 * would evict every resolved image on an upgrade to buy exactly that nothing.
 *
 * With no artifact scope the artifact segment is empty rather than absent, so a
 * scoped read can never collide with an unscoped one (the new-conversation
 * modal's strip is the live unscoped caller). `null` for the epic is only
 * reachable before a handle exists, where the fetcher throws anyway.
 */
function epicAttachmentScopeKey(
  handle: OpenEpicStoreHandle | null,
  scope: ArtifactAttachmentScopeValue | null,
): string {
  return JSON.stringify([
    "epic-attachment",
    scope?.hostId ?? "",
    scope?.epicId ?? handle?.epicId ?? "",
    scope?.artifactId ?? "",
  ]);
}

/**
 * A signal that fires when EITHER the caller's does or the arm generation ends.
 *
 * `AbortSignal.any` would be one line and is deliberately not used: the mobile
 * shell's deployment floor predates it, and there it throws out of the call
 * rather than degrading - the same reason `clients/shared/auth/request-abort.ts`
 * hand-rolls its composition.
 *
 * `clear()` is not optional bookkeeping, the same point
 * `composeRequestAbort` makes about its own. `once: true` would remove only
 * the listener that FIRED, and on the ordinary path neither fires - the fetch
 * simply resolves. The arm signal outlives the fetch by design and is shared
 * by every image in the epic, so each resolved thumbnail would leave a live
 * composed controller attached to it until the arm next changed.
 */
interface ArmScopedAbort {
  readonly signal: AbortSignal;
  /** Call once the fetch settles, on every path including failure. */
  readonly clear: () => void;
}

function signalUntilArmChanges(
  callerSignal: AbortSignal,
  armSignal: AbortSignal,
): ArmScopedAbort {
  const noop = (): void => {};
  if (armSignal.aborted) return { signal: armSignal, clear: noop };
  if (callerSignal.aborted) return { signal: callerSignal, clear: noop };
  const controller = new AbortController();
  const detach = (): void => {
    callerSignal.removeEventListener("abort", forward);
    armSignal.removeEventListener("abort", forward);
  };
  const forward = (): void => {
    detach();
    controller.abort();
  };
  callerSignal.addEventListener("abort", forward);
  armSignal.addEventListener("abort", forward);
  return { signal: controller.signal, clear: detach };
}

/** Synchronously checks the currently-open epic's local attachment replica. */
export function useEpicAttachmentBytesPresence():
  | ((hash: string) => boolean)
  | null {
  const handle = useOpenEpicHandle();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const hasAttachmentBytes = useCallback(
    (hash: string) => handle.store.getState().hasAttachmentBytes(hash),
    [handle],
  );
  return snapshotLoaded ? hasAttachmentBytes : null;
}

/**
 * Resolves an ARTIFACT image attachment's `src`: persisted images (`hash`)
 * resolve through {@link useEpicImageFetcher} (the artifact's host on the lane
 * arm, the epic doc replica on `@1`) into a shared blob URL via the
 * content-addressed cache; draft/optimistic images use their inline `dataUrl`.
 * Persisted images become unavailable after the grace window, but the
 * underlying acquisition remains recoverable when bytes arrive later.
 *
 * While the host says it is downloading the bytes the image reads as loading,
 * however long that takes: even if the window had already run out before the
 * host first said so, and even if this view had already rested unavailable
 * (its retries spent before an in-place host upgrade, or another view of the
 * same image starting the download). No window runs meanwhile, and a fresh one
 * starts when the download ends. The window runs here rather than in the blob
 * hook, so neither restarts the acquisition or its retry ladder.
 */
export function useAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
): AttachmentBlobSrcState {
  const fetcher = useEpicImageFetcher();
  const identity =
    hash === null ? null : buildScopedImageCacheKey(fetcher.scopeKey, hash);
  const graceWindow = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        identity === null
          ? () => {}
          : subscribeDownloadWatch(identity, onChange),
      [identity],
    ),
    () => (identity === null ? 0 : graceWindowOf(identity)),
  );
  const blob = useImageBlobUrlState(hash, mediaType, fetcher, null);
  const graceExpired = useGraceWindowExpired(identity, graceWindow);
  const state = attachmentBlobSrcState(hash, mediaType, dataUrl, blob);
  if (state.status === "ready") return state;
  if (graceWindow === null) return { status: "loading", src: null };
  return graceExpired ? { status: "unavailable", src: null } : state;
}

/**
 * The same resolution, for an image rendered inside a CHAT: bytes come off the
 * chat plane (`epic.readChatAttachment` on the tile's host) with the epic doc
 * as the legacy fallback. The chat scope comes from
 * `ChatAttachmentScopeContext`; see `use-chat-image-fetcher.ts` for the chain
 * and why the chat id is part of it. Outside a chat tile there is no scope, and
 * this degrades to the doc-replica read those surfaces already used.
 */
export function useChatAttachmentBlobSrc(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
): AttachmentBlobSrcState {
  const fetcher = useChatImageFetcher();
  const blob = useImageBlobUrlState(
    hash,
    mediaType,
    fetcher,
    IMAGE_UNAVAILABLE_GRACE_MS,
  );
  return attachmentBlobSrcState(hash, mediaType, dataUrl, blob);
}

function attachmentBlobSrcState(
  hash: string | null,
  mediaType: string,
  dataUrl: string | null,
  blob: ImageBlobUrlState,
): AttachmentBlobSrcState {
  if (hash !== null) {
    return blob.status === "ready"
      ? { status: "ready", src: blob.url, mediaType: blob.mediaType }
      : { status: blob.status, src: null };
  }
  return dataUrl === null
    ? { status: "unavailable", src: null }
    : { status: "ready", src: dataUrl, mediaType };
}
