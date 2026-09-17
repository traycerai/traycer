/**
 * Dedicated landing image import path. Unlike chat/new-conversation restore
 * (which materializes hash-addressed images back to inline base64), landing
 * owns a hash-addressed image store of its own: imported content must resolve
 * straight from the source blob to this window's landing partition, never
 * through an inline base64 detour or the fire-and-forget
 * `reingestPendingImages` sweep. No image is exposed to the landing draft
 * until its bytes are durably written here.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  ImageBlobCorruptError,
  ImageBlobMissingError,
  type ImageBlob,
} from "@/lib/attachments/image-bytes";
import {
  collectImageAtoms,
  type ComposerImageAtom,
} from "@/lib/composer/image-atoms";
import {
  showLandingImageBudgetExceededToast,
  tryReserveLandingImageResidency,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import { putImage } from "@/lib/composer/landing-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";

export interface LandingImageImportResult {
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

export interface LandingImageImportInput {
  readonly content: JsonContent;
  /**
   * Authoritative reference list for this content's image blobs, captured by
   * whatever produced it rather than re-derived from the content itself. An
   * image node whose hash is not in here has no resolvable blob.
   */
  readonly blobHashes: readonly string[];
  /** Resolves one referenced blob; `null` when it is not there. */
  readonly readBlob: (hash: string) => Promise<ImageBlob | null>;
  readonly draftId: string | null;
}

/**
 * Resolves every source-hash image referenced by `content` and writes it into
 * this window's landing partition, returning content rewritten to landing
 * hashes with fresh node ids. Only `id` and `hash` change; `fileName`,
 * `mimeType`, and `size` carry over unchanged, matching the in-place rewrite
 * `rewriteImageAttachmentHashById` already performs for a normal paste.
 *
 * Reads resolve before any budget is reserved, so an unresolvable blob throws
 * before landing storage is touched (surfaces the same "image could not be
 * read" messaging restore already uses for chat/modal). Once reads are in
 * hand, capacity is reserved from their measured byte length - never from a
 * carried-over Tiptap `size` attribute - via the canonical
 * `tryReserveLandingImageResidency`, which stays held across the writes below AND
 * the caller's subsequent destination decision (see
 * `LandingImageImportResult.reservation`). Writes run sequentially so a
 * first/middle/last `putImage` failure stops immediately: this function
 * releases the reservation itself and reports `null`, while bytes already
 * written before the failure are not rolled back. They become landing
 * orphans for the existing reconcile sweep.
 *
 * Returns `null` on measured-budget rejection or a `putImage` failure (both
 * release their own reservation before returning).
 */
export async function importImagesIntoLanding(
  input: LandingImageImportInput,
): Promise<LandingImageImportResult | null> {
  const atoms = uniqueImageAtomsInOrder(input.content);
  if (atoms.length === 0) {
    // Nothing to charge - hand back a reservation whose release is trivially
    // a no-op rather than reserving zero candidates for it.
    return {
      content: input.content,
      reservation: { release: () => undefined, settleStored: () => undefined },
    };
  }

  const referenced = new Set(input.blobHashes);
  const resolved: Array<{
    readonly sourceHash: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
  }> = [];
  for (const atom of atoms) {
    const sourceHash = atom.hash;
    // `uniqueImageAtomsInOrder` already filtered out null hashes.
    if (sourceHash === null) continue;
    const blob = referenced.has(sourceHash)
      ? await input.readBlob(sourceHash)
      : null;
    if (blob === null) {
      throw new ImageBlobMissingError();
    }
    // The node's own declared MIME/size can diverge from what the verified
    // blob actually is. Metadata disagreement is corruption: preserve the
    // source rather than import mismatched content into the landing draft.
    if (
      atom.mimeType !== blob.mimeType ||
      atom.size !== blob.bytes.byteLength
    ) {
      throw new ImageBlobCorruptError();
    }
    resolved.push({ sourceHash, bytes: blob.bytes });
  }

  // RESIDENCY admission, not the ordinary kind. These bytes are about to be
  // written into the partition, and the ordinary path charges nothing for a
  // candidate whose hash is already a live root - which is right for a hash
  // whose bytes are here, and wrong for a source hash that is rooted while
  // absent: `rootByteCost` prices that at zero, so importing it was free.
  // A 68-byte paste was being refused at the same moment this could write
  // megabytes.
  const reservation = tryReserveLandingImageResidency(
    resolved.map(({ sourceHash, bytes }) => ({
      hash: sourceHash,
      bytes: bytes.byteLength,
    })),
  );
  if (reservation === null) {
    showLandingImageBudgetExceededToast(input.draftId);
    return null;
  }

  const landingHashBySourceHash = new Map<string, string>();
  for (const { sourceHash, bytes } of resolved) {
    let landingHash: string;
    try {
      landingHash = await putImage(bytes);
    } catch {
      reservation.release();
      return null;
    }
    landingHashBySourceHash.set(sourceHash, landingHash);
  }

  return {
    content: rewriteToLandingHashes(input.content, landingHashBySourceHash),
    reservation,
  };
}

/**
 * Image atoms referenced by `content`, deduped by hash, first-occurrence
 * order. Carries each atom's declared `mimeType`/`size` through (not just
 * the hash) so the caller can verify them against the resolved blob.
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
  landingHashBySourceHash: ReadonlyMap<string, string>,
): JsonContent {
  if (node.type === "imageAttachment") {
    const sourceHash = stringValue(node.attrs?.hash);
    const landingHash =
      sourceHash === null ? undefined : landingHashBySourceHash.get(sourceHash);
    if (landingHash !== undefined) {
      return {
        ...node,
        attrs: { ...node.attrs, id: crypto.randomUUID(), hash: landingHash },
      };
    }
  }
  if (node.content === undefined) return node;
  return {
    ...node,
    content: node.content.map((child) =>
      rewriteToLandingHashes(child, landingHashBySourceHash),
    ),
  };
}
