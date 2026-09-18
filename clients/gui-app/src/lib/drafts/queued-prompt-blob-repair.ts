import {
  type DraftBlobClient,
  forgetConfirmedBlobs,
  putDraftBlobs,
} from "@/lib/drafts/draft-blob-transport";

/**
 * What a repair pass concluded about the bytes the host said it was missing.
 *
 * Two outcomes and no third, because the caller has exactly two acts available:
 * resume the queue, or leave it paused and say so. "Partially repaired" is not
 * a state the queue can be in - the drain re-runs the whole item.
 */
export type QueuedPromptBlobRepairVerdict = "repaired" | "bytes-missing";

/**
 * Put back the bytes a queued prompt's drain could not find, and report whether
 * the item is now sendable.
 *
 * THE MEMO RETRACTION PROTECTS THE NEXT SEND, NOT THIS UPLOAD - and the
 * distinction is worth stating because the obvious reading is wrong.
 * `putDraftBlobs` does NOT consult `confirmedBlobsByHost`; the confirmed-filter
 * lives one layer up, in `confirmAttachmentsByHash`. So the re-upload below
 * runs whether or not this line is here, and a test asserting only "the put
 * happened" stays green with the forget deleted (established by ablation, not
 * by reading).
 *
 * What the forget buys is the state the memo is left in when the re-upload
 * FAILS. `confirmedBlobsByHost` records "this host acked this digest" for the
 * renderer's lifetime, and the host has just told us it does not hold these
 * bytes - so for exactly these hashes the memo is a lie. Left standing, the
 * NEXT send skips the upload at `confirmAttachmentsByHash` and ships a hash the
 * host has already refused, which is the loop the queued-repair arm exists to
 * break. Retracting rather than bypassing is the same argument: a bypass would
 * fix this one pass and leave the lie in place.
 *
 * ALL-OR-NOTHING against `putDraftBlobs`'s OWN answer rather than against the
 * hashes we asked for: it returns only the subset it got an ack for, and
 * silently skips a hash with no local bytes, a digest mismatch, an over-cap
 * blob or a failed put. A caller that read "no throw" as "uploaded" would
 * resume on bytes that never landed.
 *
 * An EMPTY `missingHashes` is `"bytes-missing"`, not a vacuous success. The
 * host refused the item for want of attachment bytes but named none, so there
 * is nothing this pass can have fixed; resuming would re-run the drain into the
 * identical refusal, and on a durable event that is a loop. Leaving it paused
 * costs the user one manual retry and cannot spin.
 */
export async function repairQueuedPromptBlobs(input: {
  readonly hostId: string;
  readonly client: DraftBlobClient;
  readonly missingHashes: ReadonlyArray<string>;
}): Promise<QueuedPromptBlobRepairVerdict> {
  if (input.missingHashes.length === 0) return "bytes-missing";
  forgetConfirmedBlobs(input.hostId, input.missingHashes);
  const confirmed = new Set(
    await putDraftBlobs(input.hostId, input.client, input.missingHashes),
  );
  for (const hash of input.missingHashes) {
    if (!confirmed.has(hash)) return "bytes-missing";
  }
  return "repaired";
}
