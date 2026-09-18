import type { ImageBytes } from "@/lib/attachments/image-bytes";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { DraftWrite } from "@traycer/protocol/host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  getImageBytes,
  putImageBytesAtHash,
} from "@/lib/composer/composer-image-store";
import { bytesToBase64, base64ToBytes } from "@/lib/composer/image-base64";
import { sniffImageMimeType } from "@/lib/composer/prompt-stash-image-signature";
import { readPromptStashRestoreBlobs } from "@/lib/composer/prompt-stash-repository";
import type { PromptStashImageBlob } from "@/lib/composer/prompt-stash-codec";
import { appLogger, describeLogError } from "@/lib/logger";
import { blobHashesOfWrite } from "./draft-write-codec";
import { DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS } from "./draft-blob-transport-budget";
import { isDraftsCapabilityMissing } from "./draft-capability";

const blobUnsupportedHosts = new Set<string>();

/**
 * Which blob digests this renderer has seen a host ACK, keyed by host.
 *
 * The point is the submit path: an image is uploaded once when it is pasted
 * (the draft mirror's `putDraftBlobsForWrite`), and a create that then sends
 * the same image BY HASH must not push the bytes a second time - that upload is
 * the whole cost the by-reference create exists to remove. Every `putDraftBlobs`
 * ack lands here so the one memo answers for both callers.
 *
 * HOST-KEYED, because the fact is about a host's staging tier and not about the
 * image: a draft pasted while pinned to host A and submitted on host B has
 * confirmed bytes on A and none on B, and a flat set would skip B's upload and
 * send it a hash it cannot resolve.
 *
 * It can go STALE in one direction only - the host's staging tier sweeps on
 * quota or idle age - and on the CREATE path that direction is recoverable: a
 * hash the host no longer holds comes back as the `missing-attachment-bytes`
 * refusal, whose remedy calls {@link forgetConfirmedBlobs} and re-uploads. So a
 * stale entry costs one refusal round trip, while the absent memo would cost
 * every create a full re-upload.
 *
 * ON THE SEND PATH it is recoverable both ways, but by two different routes,
 * and the split is worth stating because the difference is not where the
 * refusal comes from - it is whether anything is handed back to a composer:
 *
 *  - A live send is refused at `handleSend`'s dangling-hash chokepoint, which
 *    rejects the send FRAME. The renderer sees that as a rejected `actionAck`,
 *    hands the prompt back to the composer, and retracts these acks on the way
 *    (`forgetRefusedContentBlobAcks` in `chat-session-store.ts`, which carries
 *    the full enumeration of restore arms). So the resend re-uploads.
 *  - A QUEUED prompt refused at drain time is recoverable too, but by a
 *    different route, because nothing is handed back to the composer:
 *    `failQueuedPromptPreparation` writes a `send.failed` row and PAUSES the
 *    queue with the item retained, so there is no restore arm to retract from.
 *    `use-queued-prompt-blob-repair.ts` reads that durable row's typed
 *    metadata, calls {@link forgetConfirmedBlobs} for the hashes the host
 *    named, re-uploads them and resumes the queue - so the acks are retracted
 *    here as well, just from the event rather than from a restored document.
 *    The host's queued drain now materializes from the item author's staging
 *    tier before its dangling-hash guard, which is what makes that re-upload
 *    visible to the retry rather than invisible to it.
 *
 *    That arm is bounded to ONE repair per queued item, so a host that still
 *    cannot find the bytes ends in a visible paused state rather than a loop;
 *    the user's way out there is the queue row itself, which stays editable.
 */
const confirmedBlobsByHost = new Map<string, Set<string>>();

/**
 * Uploads currently on the wire, keyed by host and digest, so two callers that
 * want the same bytes on the same host send ONE body.
 *
 * The memo above answers "already acked"; this answers "acking right now", and
 * the gap between them is a real window with two real occupants. Pasting an
 * image starts the draft mirror's `putDraftBlobsForWrite`; pressing send before
 * that ack arrives runs `confirmAttachmentsByHash`, which finds no memo entry
 * (there is none until the ack) and starts a second upload of the same
 * multi-megabyte body.
 *
 * NOTHING BELOW THIS LAYER DEDUPES IT, which is why the join lives here:
 * `drafts.putBlob` is `mode: "fifo"` in the policy table, and the request
 * coordinator's `selectJob` returns `null` for every FIFO submission by
 * construction - FIFO jobs are never joined onto an in-flight one, however
 * identical their params. The host would cope (the put is content-addressed and
 * carries `idempotencyKey: sha256`), so this is about the bytes on the wire, not
 * about correctness on disk.
 *
 * KEYED BY HOST, NOT BY CLIENT: the fact is about a host's staging tier, so two
 * different client objects addressing the same host are joinable and must be.
 *
 * It holds an entry only while the request is live. A caller that needs a FRESH
 * upload - the `missing-attachment-bytes` repair, after the host has swept the
 * bytes - runs strictly after its create came back refused, so there is nothing
 * in flight to join and it issues a real put. Single-flight narrows concurrency;
 * it never answers from history. That is `confirmedBlobsByHost`'s job, and
 * `putDraftBlobs` deliberately does not consult it.
 */
const putsInFlight = new Map<string, Promise<PutBlobOutcome>>();

export function resetDraftBlobTransportForTests(): void {
  blobUnsupportedHosts.clear();
  confirmedBlobsByHost.clear();
  putsInFlight.clear();
}

/** Whether `hash` has been acked by `hostId` during this renderer's lifetime. */
export function draftBlobConfirmedOnHost(
  hostId: string,
  hash: string,
): boolean {
  return confirmedBlobsByHost.get(hostId)?.has(hash) === true;
}

/**
 * Drop this host's ack for these digests, because the host has just said it no
 * longer holds them.
 *
 * The one place the client ever LEARNS the memo is stale is a refusal naming
 * those hashes, so that is the one place this is called from. Bypassing the
 * memo (which `putDraftBlobs` does) is not the same thing: bypassing re-uploads
 * now, while the entry still claims `confirmed` for any hash whose re-upload
 * failed - no local bytes, a digest mismatch - and the NEXT message carrying it
 * skips the upload all over again on the strength of an ack that was disproved.
 * Clearing first means the memo only ever holds acks the host has not retracted.
 */
export function forgetConfirmedBlobs(
  hostId: string,
  hashes: ReadonlyArray<string>,
): void {
  const existing = confirmedBlobsByHost.get(hostId);
  if (existing === undefined) return;
  for (const hash of hashes) existing.delete(hash);
  if (existing.size === 0) confirmedBlobsByHost.delete(hostId);
}

function rememberConfirmedBlobs(
  hostId: string,
  hashes: ReadonlyArray<string>,
): void {
  if (hashes.length === 0) return;
  const existing = confirmedBlobsByHost.get(hostId);
  const set = existing ?? new Set<string>();
  for (const hash of hashes) set.add(hash);
  if (existing === undefined) confirmedBlobsByHost.set(hostId, set);
}

/**
 * Drop the "this host withholds blob methods" cache so the next put/read
 * re-probes. Same shape as T6's scope-cache invalidate: a reconnecting
 * session (host upgraded mid-lifetime) is the signal, not a timer.
 */
export function forgetBlobUnsupportedHost(hostId: string): void {
  blobUnsupportedHosts.delete(hostId);
}

export function hostWithholdsDraftBlobs(hostId: string): boolean {
  return blobUnsupportedHosts.has(hostId);
}

function markBlobUnsupported(hostId: string): void {
  blobUnsupportedHosts.add(hostId);
}

function isBlobUnsupported(error: unknown): boolean {
  return (
    isDraftsCapabilityMissing(error) ||
    (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED")
  );
}

async function localBytesForHash(
  hash: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const fromLanding = await getImageBytes(hash);
  if (fromLanding !== undefined) return fromLanding;
  const stash = await readPromptStashRestoreBlobs([hash]);
  if (stash.status !== "ok") return null;
  return stash.blobs.get(hash)?.bytes ?? null;
}

/**
 * Upload every `blobHashes` entry the local partition (or stash repo)
 * still holds. Missing local bytes and digest-mismatch skip that hash
 * (fail closed per-image). A host that withholds the methods is treated
 * as an old host: hash-only content, never an error surface.
 */
export type DraftBlobClient = {
  readonly request: HostRequester<HostRpcRegistry>["request"];
  /**
   * The combined dispatch, for the put path: an upload needs BOTH its digest
   * idempotency key (a replayed put of the same bytes is the same put) and the
   * extended response budget a multi-megabyte body earns, and no narrow entry
   * point carries the two together.
   *
   * Widened here rather than at the call site so every `DraftBlobClient`
   * provider - the draft mirror, tab recovery, the composer - hands over a
   * client that CAN make that call. A `Pick<…, "request">` was enough while
   * uploads rode the default budget with no key; it is not enough now, and a
   * type that still said so would push the choice back to whichever caller
   * happened to be first.
   */
  readonly requestWithOptions: HostRequester<HostRpcRegistry>["requestWithOptions"];
};

export async function putDraftBlobsForWrite(
  hostId: string,
  client: DraftBlobClient,
  write: DraftWrite,
): Promise<ReadonlyArray<string>> {
  return putDraftBlobs(hostId, client, blobHashesOfWrite(write));
}

/**
 * What one hash's upload settled as.
 *
 * `unsupported` is not a per-hash fact and is the reason this is three-valued
 * rather than a boolean: the host withholds the blob methods entirely, so the
 * caller must stop the whole batch rather than try the next digest.
 */
type PutBlobOutcome = "confirmed" | "skipped" | "unsupported";

export async function putDraftBlobs(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyArray<string>> {
  if (hashes.length === 0) return [];
  if (blobUnsupportedHosts.has(hostId)) return [];
  const confirmed: string[] = [];
  for (const sha256 of hashes) {
    const outcome = await putOneDraftBlob(hostId, client, sha256);
    if (outcome === "unsupported") return confirmed;
    if (outcome === "confirmed") confirmed.push(sha256);
  }
  return confirmed;
}

/**
 * One digest, joined to whatever identical upload is already on the wire.
 *
 * NUL-joined key, as everywhere else in this renderer: no host id or hex digest
 * can contain one, so two pairs cannot collide on a shared separator.
 */
function putOneDraftBlob(
  hostId: string,
  client: DraftBlobClient,
  sha256: string,
): Promise<PutBlobOutcome> {
  const key = `${hostId}\0${sha256}`;
  const existing = putsInFlight.get(key);
  if (existing !== undefined) return existing;
  const started = dispatchDraftBlobPut(hostId, client, sha256).finally(() => {
    putsInFlight.delete(key);
  });
  putsInFlight.set(key, started);
  return started;
}

async function dispatchDraftBlobPut(
  hostId: string,
  client: DraftBlobClient,
  sha256: string,
): Promise<PutBlobOutcome> {
  const bytes = await localBytesForHash(sha256);
  if (bytes === null) return "skipped";
  try {
    const response = await client.requestWithOptions(
      "drafts.putBlob",
      { sha256, bytesBase64: bytesToBase64(bytes) },
      {
        // The blob's OWN digest. A `putBlob` that the transport replays -
        // because a relay leg died mid-body and the retrying messenger
        // re-sent it - is by construction the same upload: the params are
        // byte-identical, and the host stores content-addressed bytes, so
        // the second arrival resolves to the same file rather than a second
        // copy. This is the narrow promise the key allowlist on
        // `requestWithIdempotencyKey` asks for, and `epic.create` (keyed on
        // the epicId it mints) is the other half of it.
        //
        // It is NOT what keeps two concurrent callers to one body: the key
        // deduplicates a TRANSPORT replay of one submission, while two
        // submissions are two FIFO jobs the coordinator never joins. That is
        // `putsInFlight`'s job, above.
        idempotencyKey: sha256,
        responseTimeoutMs: DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS,
        // No floor: the method has existed since `drafts@1.0`, and a host
        // that withholds it is already handled as an old host below.
        requiredHostMethodVersion: null,
        // No caller cancellation. The upload is a background mirror of a
        // draft the user has already pasted into; abandoning it mid-body
        // would leave the hash unconfirmed and force an inline base64 send
        // for bytes that were nearly there. Now that joiners share this one
        // request, a caller-owned abort would also cancel somebody else's.
        signal: undefined,
      },
    );
    if (response.ok) {
      rememberConfirmedBlobs(hostId, [sha256]);
      return "confirmed";
    }
    appLogger.warn("[draft-blobs] putBlob digest-mismatch", { sha256 });
    return "skipped";
  } catch (error: unknown) {
    if (isBlobUnsupported(error)) {
      markBlobUnsupported(hostId);
      return "unsupported";
    }
    appLogger.warn("[draft-blobs] putBlob failed", {
      sha256,
      error: describeLogError(error),
    });
    return "skipped";
  }
}

/**
 * Fetch missing hashes into the window-partitioned composer image store.
 * Already-local hashes are left alone. `missing` / corrupt collapse to
 * skip (images render unavailable).
 */
export function readDraftBlobsIntoLocalStore(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  return readDraftBlobs(hostId, client, hashes, putImageBytesAtHash);
}

/** Read without storing so recovery can admit the complete byte batch first.
 * The recovery writer must validate digests before installing these bytes.
 */
export function readDraftBlobsForRecovery(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  return readDraftBlobs(hostId, client, hashes, () => Promise.resolve(true));
}

async function readDraftBlobs(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
  store: (hash: string, bytes: ImageBytes) => Promise<boolean>,
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  const images = new Map<string, PromptStashImageBlob>();
  if (hashes.length === 0) return images;
  if (blobUnsupportedHosts.has(hostId)) return images;
  for (const sha256 of hashes) {
    const existing = await getImageBytes(sha256);
    if (existing !== undefined) {
      const mimeType = sniffImageMimeType(existing) ?? "image/png";
      images.set(sha256, { bytes: existing, mimeType });
      continue;
    }
    try {
      const response = await client.request("drafts.readBlob", { sha256 });
      if (!response.ok) continue;
      const bytes = base64ToBytes(response.bytesBase64);
      if (bytes === null) continue;
      const stored = await store(sha256, bytes);
      if (!stored) continue;
      const mimeType = sniffImageMimeType(bytes) ?? "image/png";
      images.set(sha256, { bytes, mimeType });
    } catch (error: unknown) {
      if (isBlobUnsupported(error)) {
        markBlobUnsupported(hostId);
        return images;
      }
      appLogger.warn("[draft-blobs] readBlob failed", {
        sha256,
        error: describeLogError(error),
      });
    }
  }
  return images;
}
