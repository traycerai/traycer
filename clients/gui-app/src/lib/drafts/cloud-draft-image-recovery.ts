/**
 * The third and last byte source for a draft image: the cloud
 * `image-attachment` blob the owning host already published.
 *
 * ## Why this leg has to exist
 *
 * The other two legs are both *this device's*: the window's own image partition
 * and `drafts.readBlob` on a host this window holds a draft mirror on. Neither
 * can answer in the two cases the draft replica was designed for - a SECOND
 * WINDOW whose tiles are bound to a different host than the draft's owner, and
 * a SECOND DEVICE whose owner host is asleep. In both, the document arrives
 * through the cloud ingest carrying nothing but content hashes, and every local
 * source is empty by construction.
 *
 * The bytes are already in the cloud: `DraftPublicationService.publishBlobs`
 * uploads each `blobHashes` entry as `{ taskId: scopeId, chatId: draftId,
 * ref: { kind: "image-attachment", sha256 } }` before it commits the head. What
 * was missing was the client asking.
 *
 * ## The route
 *
 * `epic.readCloudChatPayload`, NOT `epic.readCloudChatPart`. The part reader
 * fetches `api/chats/part` and serves shards only; the payload reader fetches
 * `api/chats/blob` by `(blobKind, sha256)`, and `image-attachment` is one of the
 * three kinds it serves. Same byte-pipe posture as every other cloud read: the
 * request goes to whatever host THIS DEVICE runs - generally not the owning host,
 * which is exactly what makes the owner-offline case work - and the host neither
 * parses nor verifies anything it moves.
 *
 * ## Two entry points, one fetch
 *
 * - {@link recoverCloudDraftImages} is the eager pass the cloud ingest runs once
 *   a document has been applied: it warms the partition so a later submit is not
 *   paying for a round trip per image inside a held-open send.
 * - {@link readCloudDraftImageBytes} is the lazy leg `resolveDraftImageBytes`
 *   calls. It is what makes rendering deterministic rather than a race: a strip's
 *   own first fetch performs the cloud read, instead of hoping the eager pass
 *   lands inside `useImageBlobUrlState`'s four-attempt retry ladder.
 *
 * Both go through {@link transferFor}, which is single-flight per hash so the
 * two never dial the same blob twice. What differs is how long each is willing
 * to WAIT: the eager pass holds its worker slot for the whole transfer, while a
 * lazy reader - which may be a submit held open - waits a bounded time and then
 * settles for a miss, leaving the transfer to finish and warm the partition for
 * whoever asks next.
 *
 * ## Nothing here throws, and nothing unverified is kept
 *
 * `resolveDraftImageBytes` promises its callers bytes-or-null and three submit
 * continuations discard its promise, so an escaping rejection would abandon a
 * send with no message. Every failure below - a refusal, a timeout, a decode
 * fault, a host that predates the method - answers `null` and leaves the node
 * hash-only for the host's own dangling-hash guard to rule on.
 *
 * Verification is {@link putImageBytesAtHash}, which hashes the bytes and
 * refuses to write them under an address they do not answer to. Bytes reach a
 * caller only after that write has succeeded, so a digest mismatch is stored
 * nowhere and returned to nobody.
 */
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  MAX_ENCODED_PAYLOAD_CHARS,
  MAX_RENDERED_PAYLOAD_BYTES,
} from "@/lib/chats/cloud-chat-payloads";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import {
  getImageBytes,
  putImageBytesAtHash,
} from "@/lib/composer/landing-image-store";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

import type { DraftBlobClient } from "./draft-blob-transport";

/**
 * How long one blob read is waited on.
 *
 * Its own bound rather than the RPC's, because the lazy leg runs inside
 * `prepareDraftImageInlining`'s bounded reconcile loop while a submit is held
 * open: a send must not sit on the frame timeout once per unresolved image. The
 * request itself is not cancellable (`HostRequester.request` takes no signal),
 * so this stops the WAIT, not the transfer - a late answer simply arrives for
 * nobody, and the next ask finds the bytes local if it landed.
 */
const CLOUD_DRAFT_IMAGE_READ_TIMEOUT_MS = 10_000;

/**
 * The transfer's own hard cap - a leak guard, not a responsiveness bound.
 *
 * Deliberately far above the caller's wait. Its only job is to stop a wedged
 * socket or a blocked IndexedDB from parking an eager worker (and the ingest
 * awaiting that pass) for the life of the renderer. If this ever fires on a
 * healthy connection the constant is wrong, not the design.
 */
const CLOUD_DRAFT_IMAGE_TRANSFER_TIMEOUT_MS = 60_000;

/** What {@link waitBounded} answers when the wait, not the work, ended. */
const READ_TIMED_OUT = Symbol("cloud-draft-image-read-timed-out");

/** Simultaneous blob reads in one eager pass. A draft holds a handful. */
const CLOUD_DRAFT_IMAGE_RECOVERY_CONCURRENCY = 4;

/**
 * How many hashes keep a remembered cloud source.
 *
 * The map exists so the LAZY leg can name a draft it was told about minutes
 * ago; it is not a cache of bytes and holds none. Bounded so a long session
 * that ingests many drafts cannot grow it without limit - eviction costs at
 * worst one image that falls back to hash-only, which is this leg's ordinary
 * miss.
 */
const CLOUD_DRAFT_IMAGE_SOURCE_LIMIT = 512;

/**
 * Where one hash's published bytes can be asked for.
 *
 * `client` is the requester of the host that INGESTED the draft - the byte pipe,
 * not the owner. It is captured rather than looked up so this module stays a
 * leaf the resolver can import without dragging in the mirror coordinator; a
 * re-ingest replaces it with whatever mirror is mounted then, and a requester
 * whose host has gone simply fails the read.
 */
interface CloudDraftImageSource {
  readonly identity: CloudChatIdentity;
  readonly hostId: string;
  readonly client: DraftBlobClient;
}

/**
 * How many distinct addresses one digest keeps.
 *
 * More than one because a cloud read is addressed by a DRAFT's identity, not by
 * the digest: two drafts can name the same image and only one of them have a
 * retrievable blob behind it. Publication is advisory - it is skipped when the
 * publishing host no longer held the bytes, and a blob can be swept later - so
 * the newest address is not the likeliest to answer, it is only the newest.
 * Small because the list is a fallback chain walked on a miss, not an index.
 */
const CLOUD_DRAFT_IMAGE_SOURCES_PER_HASH = 3;

const sourcesByHash = new Map<string, CloudDraftImageSource[]>();
const inFlightByHash = new Map<string, Promise<ImageBytes | null>>();
/** Hosts that answered `E_HOST_UNSUPPORTED`: never re-probed per image. */
const payloadUnsupportedHosts = new Set<string>();

/**
 * Per-host generation of the payload-capability verdict, bumped by every
 * re-probe signal.
 *
 * A cloud payload request cannot be cancelled, so one started before a
 * re-bootstrap can reject with `E_HOST_UNSUPPORTED` after the reset has already
 * cleared the old verdict. Re-recording it there would undo the re-probe with
 * the very answer the re-probe existed to discard, and every candidate on that
 * host would be skipped again until the next reconnect. So a refusal is
 * recorded only if the generation it started under still stands - the same
 * fence `uploadOneDraftBlob` applies to its own late results, for the same
 * reason and on the same signal.
 */
const payloadCapabilityEpochs = new Map<string, number>();

function payloadCapabilityEpochOf(hostId: string): number {
  return payloadCapabilityEpochs.get(hostId) ?? 0;
}

export function resetCloudDraftImageRecoveryForTests(): void {
  sourcesByHash.clear();
  inFlightByHash.clear();
  payloadUnsupportedHosts.clear();
  payloadCapabilityEpochs.clear();
}

/**
 * Re-probe a host that answered `E_HOST_UNSUPPORTED`.
 *
 * Same signal and same reason as `forgetBlobUnsupportedHost`: a new mirror
 * session is a new host connection, so a host that UPGRADED while this renderer
 * stayed up must not be stuck payload-less until the app restarts. Kept as a
 * sibling of that call rather than folded into it - the two memos are about
 * different method families and a host can perfectly well have one and not the
 * other.
 */
export function forgetCloudDraftPayloadUnsupportedHost(hostId: string): void {
  payloadCapabilityEpochs.set(hostId, payloadCapabilityEpochOf(hostId) + 1);
  payloadUnsupportedHosts.delete(hostId);
}

export interface CloudDraftImageRecoveryInput {
  /** The draft's cloud identity: drafts scope, draft id, owning user. */
  readonly identity: CloudChatIdentity;
  /** The host the read is piped through. Keys the unsupported memo. */
  readonly hostId: string;
  readonly client: DraftBlobClient;
  readonly hashes: readonly string[];
}

/**
 * Remember where these hashes can be fetched from, without fetching anything.
 *
 * Re-recording moves a hash to the back of the eviction order on purpose: the
 * draft it belongs to was just heard from, which is the best evidence available
 * that it is the one a reader will ask about.
 */
export function recordCloudDraftImageSources(
  input: CloudDraftImageRecoveryInput,
): void {
  const source: CloudDraftImageSource = {
    identity: input.identity,
    hostId: input.hostId,
    client: input.client,
  };
  for (const hash of input.hashes) {
    // Newest FIRST, older addresses kept behind it. Re-recording still moves
    // the hash to the back of the eviction order (delete-then-set on the outer
    // map), which is the freshness signal the doc above describes; what it no
    // longer does is discard the address a previous draft published under.
    const kept = (sourcesByHash.get(hash) ?? []).filter(
      (candidate) => !sameCloudDraftImageSource(candidate, source),
    );
    sourcesByHash.delete(hash);
    sourcesByHash.set(
      hash,
      [source, ...kept].slice(0, CLOUD_DRAFT_IMAGE_SOURCES_PER_HASH),
    );
  }
  evictUnrootedOverflow();
}

/**
 * Two addresses are the same when they name the same draft through the same
 * host. The `client` is deliberately not compared: a re-ingest of the same
 * draft on a remounted mirror carries a fresh requester for the same address,
 * and keeping both would spend a candidate slot on a duplicate.
 */
function cloudDraftImageSourcesFor(
  hash: string,
): ReadonlyArray<CloudDraftImageSource> {
  return sourcesByHash.get(hash) ?? [];
}

function sameCloudDraftImageSource(
  left: CloudDraftImageSource,
  right: CloudDraftImageSource,
): boolean {
  return (
    left.hostId === right.hostId &&
    left.identity.taskId === right.identity.taskId &&
    left.identity.chatId === right.identity.chatId &&
    left.identity.ownerUserId === right.identity.ownerUserId
  );
}

/**
 * Trim back to the cap, oldest first, but never evict a hash a live draft row
 * still names.
 *
 * This map is not an expendable byte cache - it holds no bytes. It is the ONLY
 * mapping from a bare hash to a cloud address, so evicting an entry whose row
 * is still on screen does not cost a cache miss, it makes that image
 * permanently unrecoverable: the lazy leg answers `null` without contacting the
 * cloud, and the unchanged head is already in `useCloudDraftsIngest`'s ingested
 * set, so no directory refresh restores it. That is a transient first-pass miss
 * turned permanent by unrelated drafts being ingested afterwards.
 *
 * `landingLiveImageRootHashes` is the same set `landing-image-gc` reclaims
 * against, so "still needed" means here exactly what it means to the GC. Read
 * once: it walks every registered root source, and nothing can change it inside
 * this synchronous loop.
 *
 * When every entry is rooted the map is left ABOVE the cap, deliberately. It is
 * then bounded by the draft images that actually exist, which is the honest
 * bound - a constant that evicts live addresses is not a bound, it is a bug.
 */
function evictUnrootedOverflow(): void {
  if (sourcesByHash.size <= CLOUD_DRAFT_IMAGE_SOURCE_LIMIT) return;
  const rooted = landingLiveImageRootHashes();
  for (const hash of [...sourcesByHash.keys()]) {
    if (sourcesByHash.size <= CLOUD_DRAFT_IMAGE_SOURCE_LIMIT) return;
    if (rooted.has(hash)) continue;
    sourcesByHash.delete(hash);
  }
}

/**
 * Leg 3 of `resolveDraftImageBytes`, for a hash a cloud draft named.
 *
 * `null` for a hash no ingest has described - which is every hash that reached
 * this window some other way, and the reason this is a lookup rather than a
 * probe: there is no "is this digest anywhere" question to ask the cloud, only
 * "serve this chat's blob".
 */
export function readCloudDraftImageBytes(
  hash: string,
): Promise<ImageBytes | null> {
  if (cloudDraftImageSourcesFor(hash).length === 0)
    return Promise.resolve(null);
  return awaitTransferBounded(hash);
}

/**
 * Fetch every hash this document names that the partition does not already
 * hold, bounded concurrency, best effort per image.
 *
 * Called AFTER the document has been applied, and the order is load-bearing:
 * the applied row is what puts these hashes in `landingLiveImageRootHashes`, so
 * bytes written before it exist would be reachable by a reconcile. (The session
 * cache is itself a delete-root, which covers the window between a write and
 * the root appearing, but relying on that as the only protection would be
 * relying on an implementation detail of the GC.)
 *
 * Never rejects. A draft whose blobs are all missing from the cloud - publication
 * is advisory, and it skips an image whose bytes its own host no longer held -
 * simply stays hash-only, which is what the host's refusal at send is for.
 */
export async function recoverCloudDraftImages(
  input: CloudDraftImageRecoveryInput,
): Promise<void> {
  if (input.hashes.length === 0) return;
  recordCloudDraftImageSources(input);
  const pending = [...input.hashes];
  const width = Math.min(
    CLOUD_DRAFT_IMAGE_RECOVERY_CONCURRENCY,
    pending.length,
  );
  const workers: Promise<void>[] = [];
  for (let worker = 0; worker < width; worker += 1) {
    workers.push(drainCloudDraftImages(pending));
  }
  await Promise.all(workers);
}

async function drainCloudDraftImages(pending: string[]): Promise<void> {
  for (;;) {
    const hash = pending.shift();
    if (hash === undefined) return;
    // The partition first, exactly as the resolver's own leg order says. The
    // mirror leg may already have landed these bytes, and an ingest that ran
    // moments ago on another surface certainly may have.
    if (await hasLocalImageBytes(hash)) continue;
    // The TRANSFER, not a bounded wait on it: a worker that stopped waiting
    // early would take the next slot while its own download was still running,
    // so the pool would bound starts rather than concurrent work. This pass is
    // background warming with nobody blocked on it, so holding the slot for the
    // real transfer is exactly right.
    await transferFor(hash);
  }
}

async function hasLocalImageBytes(hash: string): Promise<boolean> {
  try {
    return (await getImageBytes(hash)) !== undefined;
  } catch (error: unknown) {
    // A broken IndexedDB reads as "not here", which is the case this whole
    // module exists for - never as a reason to skip the fetch.
    appLogger.warn("[cloud-draft-image] local image read failed", {
      hash,
      error: describeLogError(error),
    });
    return false;
  }
}

/**
 * The TRANSFER for one hash: request, verify, store - alive until it settles,
 * whatever any particular caller does about waiting for it.
 *
 * ## Why this is separate from a caller's wait
 *
 * An RPC cannot be cancelled, so a deadline that ends the FLIGHT does not end
 * the transfer - it only forgets it. Bounding the flight meant the bytes were
 * still coming, nobody was listening, the next ask started a second transfer of
 * the same blob, and an eager worker took another slot while the first was
 * still on the wire. On a slow connection an eight-image draft ran every read
 * at once and stored none of them.
 *
 * So the flight lives until the work settles. A caller that has waited long
 * enough stops waiting ({@link awaitTransferBounded}); the transfer carries on,
 * verifies, and writes into the partition, which is what makes the next ask a
 * local hit rather than a second download.
 *
 * Single-flight and the eager pass's concurrency bound both apply HERE, to real
 * transfers, which is the only place a bound on concurrent work can mean
 * anything.
 *
 * Keyed by hash alone, not by source. Two drafts can name one digest and the
 * bytes are the same by construction, so joining is correct - and the transfer
 * walks EVERY address recorded for the digest, so a joiner no longer inherits
 * one draft's bad luck: a chat whose blob was never published or has been swept
 * is a miss on that candidate, not on the hash.
 */
function transferFor(hash: string): Promise<ImageBytes | null> {
  const existing = inFlightByHash.get(hash);
  if (existing !== undefined) return existing;
  // The transfer's OWN cap, and the reason it is not the caller's: a caller
  // gives up to keep a submit moving, while this exists only so a wedged socket
  // or a blocked IndexedDB cannot park an eager worker - and with it the ingest
  // that awaits the pass - for the life of the renderer. Far longer than the
  // caller's wait, so it never fires on the merely-slow path the caller's
  // deadline is for.
  const transfer = waitBounded(
    readAndStoreFromAnyCloudSource(hash),
    CLOUD_DRAFT_IMAGE_TRANSFER_TIMEOUT_MS,
  )
    .then((settled) => {
      if (settled !== READ_TIMED_OUT) return settled;
      appLogger.warn("[cloud-draft-image] transfer abandoned at its own cap", {
        hash,
      });
      return null;
    })
    .finally(() => {
      inFlightByHash.delete(hash);
    });
  inFlightByHash.set(hash, transfer);
  return transfer;
}

/**
 * One caller's bounded view of {@link transferFor}.
 *
 * Timing out answers `null` and leaves the node hash-only, exactly like a miss -
 * and leaves the transfer running, so the bytes may well be local by the time
 * anything asks again. This is what a held-open submit waits on, which is why
 * the bound covers the WHOLE operation: the digest check and the IndexedDB
 * write-back are inside it, not after it. Bounding only the request left a
 * successful reply followed by a stalled write holding a send open forever.
 */
async function awaitTransferBounded(hash: string): Promise<ImageBytes | null> {
  const settled = await waitBounded(
    transferFor(hash),
    CLOUD_DRAFT_IMAGE_READ_TIMEOUT_MS,
  );
  if (settled !== READ_TIMED_OUT) return settled;
  appLogger.warn("[cloud-draft-image] blob read exceeded the caller's wait", {
    hash,
  });
  return null;
}

/**
 * Try each recorded address for `hash`, newest first, until one answers.
 *
 * Read at dispatch rather than captured with the flight, so an address recorded
 * while this transfer was queued behind the concurrency bound is included.
 * Every candidate returning `null` is an ordinary outcome - the node stays
 * hash-only and the host's guard at send is the authority.
 */
async function readAndStoreFromAnyCloudSource(
  hash: string,
): Promise<ImageBytes | null> {
  for (const source of cloudDraftImageSourcesFor(hash)) {
    const bytes = await readAndStoreCloudDraftImage(hash, source);
    if (bytes !== null) return bytes;
  }
  return null;
}

async function readAndStoreCloudDraftImage(
  hash: string,
  source: CloudDraftImageSource,
): Promise<ImageBytes | null> {
  if (payloadUnsupportedHosts.has(source.hostId)) return null;
  // Captured at the start, like the blob transport's: what matters is whether
  // the verdict this request is about to produce describes the connection that
  // is still live by the time it answers.
  const capabilityEpoch = payloadCapabilityEpochOf(source.hostId);
  // Re-read at DISPATCH, not once at construction: the eager pass and the held
  // submit both run long after the ingest decided this device could read the
  // cloud, and a session demoted in between must not spend the retained host
  // credential. Same rule `createHostCloudChatReadPort` applies per call.
  if (!authorizesCloudCapability(useAuthStore.getState().status)) return null;
  try {
    const response = await source.client.request("epic.readCloudChatPayload", {
      ...source.identity,
      ref: { kind: "image-attachment", sha256: hash },
    });
    const { outcome } = response;
    // `unavailable` (never published, or swept) and `ambiguous-identity` are
    // both ordinary answers here, not faults: the node stays hash-only and the
    // host's guard is the authority on whether the send may proceed.
    if (outcome.status !== "ok") return null;
    // Bounded BEFORE the decode, and the encoded body is bounded first: the
    // declared length is a claim by the same party that supplied the bytes, so
    // `atob` would expand an unbounded body before the length check could
    // disagree. Same two ceilings the transcript payload path applies.
    if (outcome.byteLength > MAX_RENDERED_PAYLOAD_BYTES) return null;
    if (outcome.bytesBase64.length > MAX_ENCODED_PAYLOAD_CHARS) return null;
    const bytes = base64ToBytes(outcome.bytesBase64);
    if (bytes === null) return null;
    if (bytes.byteLength !== outcome.byteLength) return null;
    // The verification, and the store, in one step. `putImageBytesAtHash`
    // hashes and refuses a mismatch, so bytes that are not the ones this hash
    // names are never written - and, because the return is gated on the write,
    // never handed to a caller either.
    if (!(await putImageBytesAtHash(hash, bytes))) {
      appLogger.warn("[cloud-draft-image] blob digest mismatch", { hash });
      return null;
    }
    return bytes;
  } catch (error: unknown) {
    if (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED") {
      // The cloud-chat surface is an optional capability. A host that predates
      // it answers this for every image, so remember it once rather than
      // spending a refused request per hash for the life of the session - but
      // only for the connection that produced the refusal. See
      // `payloadCapabilityEpochs`.
      if (payloadCapabilityEpochOf(source.hostId) === capabilityEpoch) {
        payloadUnsupportedHosts.add(source.hostId);
      } else {
        appLogger.warn("[cloud-draft-image] payload refused after re-probe", {
          hash,
        });
      }
      return null;
    }
    appLogger.warn("[cloud-draft-image] blob read failed", {
      hash,
      error: describeLogError(error),
    });
    return null;
  }
}

/**
 * `work`, or {@link READ_TIMED_OUT} once `timeoutMs` has passed.
 *
 * Stops the WAIT and never the work - `work` runs to completion either way,
 * which is the whole basis of the two lifetimes above. A sentinel rather than
 * `null` so a `work` that legitimately answers `null` cannot be confused with
 * one that never answered. A rejection still propagates, and one arriving after
 * the race has settled is handled by `Promise.race`'s own listener, so a slow
 * failure is never an unhandled rejection.
 */
function waitBounded<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof READ_TIMED_OUT> {
  let timer = 0;
  const timeout = new Promise<typeof READ_TIMED_OUT>((resolve) => {
    timer = window.setTimeout(() => {
      resolve(READ_TIMED_OUT);
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}
