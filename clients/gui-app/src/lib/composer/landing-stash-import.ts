/**
 * Dedicated landing-restore image import path. Unlike chat/new-conversation
 * restore (which materializes stash-hash images back to inline base64 via
 * `materializePromptStashEntry`), landing owns a hash-addressed image store
 * of its own: a restored prompt must resolve straight from the app-global
 * stash blob to this window's landing partition, never through an inline
 * base64 detour or the fire-and-forget `reingestPendingImages` sweep. No
 * image is exposed to the landing draft until its bytes are durably written
 * here.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { v4 as uuidv4 } from "uuid";
import {
  collectImageAtoms,
  type ComposerImageAtom,
} from "@/lib/composer/image-atoms";
import {
  reserveLandingImageBudget,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  stashImageMetadataAgreesWithBlob,
  type PromptStashEntry,
} from "@/lib/composer/prompt-stash-codec";
import {
  PromptStashCorruptBlobError,
  PromptStashMissingBlobError,
  readPromptStashRestoreBlobs,
} from "@/lib/composer/prompt-stash-repository";
import { stringValue } from "@/lib/composer/tiptap-json-content";

export interface LandingStashImportResult {
  readonly content: JsonContent;
  /**
   * The import's budget reservation, still held. The caller MUST call
   * `reservation.release()` exactly once, right after it either commits this
   * content or discovers its destination is stale - never before, and never
   * more than once (release is idempotent, but a second call is a no-op, not
   * an additional release).
   */
  readonly reservation: LandingImageBudgetReservation;
}

/**
 * Resolves every stash-hash image referenced by `entry.content` and writes
 * it into this window's landing partition, returning content rewritten to
 * landing hashes with fresh node ids. Only `id` and `hash` change; `fileName`,
 * `mimeType`, and `size` carry over unchanged, matching the in-place rewrite
 * `rewriteImageAttachmentHashById` already performs for a normal paste.
 *
 * Reads resolve before any budget is reserved, so a missing stash blob
 * throws before landing storage is touched (surfaces the same "image could
 * not be read" messaging restore already uses for chat/modal). Reads go
 * through one consistent-snapshot repository transaction keyed by the
 * entry's authoritative `blobHashes` - all-or-nothing, immune to a
 * delete-during-read race with another window. Once reads are in hand,
 * capacity is reserved from their measured byte length - never from a
 * carried-over Tiptap `size` attribute - via the canonical
 * `reserveLandingImageBudget`, which stays held across the writes below AND
 * the caller's subsequent destination decision (see
 * `LandingStashImportResult.reservation`). Writes run sequentially so a
 * first/middle/last `putImage` failure stops immediately: this function
 * releases the reservation itself and reports `null`, while bytes already
 * written before the failure are not rolled back. They become landing
 * orphans for the existing reconcile sweep.
 *
 * Returns `null` on measured-budget rejection or a `putImage` failure (both
 * release their own reservation before returning).
 */
export async function importPromptStashContentToLanding(
  entry: PromptStashEntry,
  draftId: string | null,
): Promise<LandingStashImportResult | null> {
  const stashAtoms = uniqueImageAtomsInOrder(entry.content);
  if (stashAtoms.length === 0) {
    // Nothing to charge - hand back a reservation whose release is trivially
    // a no-op rather than reserving zero candidates for it.
    return {
      content: entry.content,
      reservation: { release: () => undefined },
    };
  }

  const read = await readPromptStashRestoreBlobs(entry.blobHashes);
  if (read.status === "missing") throw new PromptStashMissingBlobError();
  if (read.status === "corrupt") throw new PromptStashCorruptBlobError();
  const blobs = read.blobs;

  const resolved: Array<{
    readonly stashHash: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
  }> = [];
  for (const atom of stashAtoms) {
    const stashHash = atom.hash;
    // `uniqueImageAtomsInOrder` already filtered out null hashes.
    if (stashHash === null) continue;
    const blob = blobs.get(stashHash);
    if (blob === undefined) {
      throw new PromptStashMissingBlobError();
    }
    // The node's own declared MIME/size can diverge from what the verified
    // blob actually is. Metadata disagreement is corruption: preserve the
    // stash rather than import mismatched content into the landing draft.
    if (!stashImageMetadataAgreesWithBlob(atom.mimeType, atom.size, blob)) {
      throw new PromptStashCorruptBlobError();
    }
    resolved.push({ stashHash, bytes: blob.bytes });
  }

  const reservation = reserveLandingImageBudget(
    draftId,
    resolved.map(({ stashHash, bytes }) => ({
      hash: stashHash,
      bytes: bytes.byteLength,
    })),
  );
  if (reservation === null) return null;

  const landingHashByStashHash = new Map<string, string>();
  for (const { stashHash, bytes } of resolved) {
    let landingHash: string;
    try {
      landingHash = await putImage(bytes);
    } catch {
      reservation.release();
      return null;
    }
    landingHashByStashHash.set(stashHash, landingHash);
  }

  return {
    content: rewriteToLandingHashes(entry.content, landingHashByStashHash),
    reservation,
  };
}

/**
 * Image atoms referenced by `content`, deduped by hash, first-occurrence
 * order. Carries each atom's declared `mimeType`/`size` through (not just
 * the hash) so the caller can verify them against the resolved stash blob.
 */
function uniqueImageAtomsInOrder(content: JsonContent): ComposerImageAtom[] {
  const seen = new Set<string>();
  const order: ComposerImageAtom[] = [];
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash === null || seen.has(atom.hash)) continue;
    seen.add(atom.hash);
    order.push(atom);
  }
  return order;
}

function rewriteToLandingHashes(
  node: JsonContent,
  landingHashByStashHash: ReadonlyMap<string, string>,
): JsonContent {
  if (node.type === "imageAttachment") {
    const stashHash = stringValue(node.attrs?.hash);
    const landingHash =
      stashHash === null ? undefined : landingHashByStashHash.get(stashHash);
    if (landingHash !== undefined) {
      return {
        ...node,
        attrs: { ...node.attrs, id: uuidv4(), hash: landingHash },
      };
    }
  }
  if (node.content === undefined) return node;
  return {
    ...node,
    content: node.content.map((child) =>
      rewriteToLandingHashes(child, landingHashByStashHash),
    ),
  };
}
