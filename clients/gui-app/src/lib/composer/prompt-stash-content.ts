import type { JsonContent } from "@traycer/protocol/common/registry";

import { base64ToBytes, bytesToBase64 } from "@/lib/composer/image-base64";
import {
  canonicalPromptStashImageFileName,
  createPromptStashImagePreparationSession,
  PROMPT_STASH_IMAGE_MAX_BYTES,
  type CanonicalImageMimeType,
  type PreparedPromptStashImage,
  type PromptStashImagePreparationSession,
} from "@/lib/composer/prompt-stash-image-preparation";
import { sniffImageMimeType } from "@/lib/composer/prompt-stash-image-signature";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { numberValue, stringValue } from "@/lib/composer/tiptap-json-content";
import type {
  PromptStashEntry,
  PromptStashImageBlob,
  PromptStashSnapshot,
} from "@/lib/composer/prompt-stash-codec";
import { stashImageMetadataAgreesWithBlob } from "@/lib/composer/prompt-stash-codec";
import {
  PromptStashCorruptBlobError,
  PromptStashMissingBlobError,
  readPromptStashRestoreBlobs,
} from "@/lib/composer/prompt-stash-repository";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { putImageBytesAtHash } from "@/lib/composer/landing-image-store";

interface PreparedOwnedImage {
  readonly bytes: ImageBytes;
  readonly byteLength: number;
  readonly hash: string;
  readonly mimeType: CanonicalImageMimeType;
}

/**
 * Wraps every `prepare()` failure (unsupported format, over the 5 MB limit,
 * couldn't decode/compress enough to fit) behind one identifiable type so
 * capture-failure messaging can give compression-specific feedback instead
 * of a generic "durable storage did not complete" fallback.
 */
export class PromptStashImagePreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptStashImagePreparationError";
  }
}

export class PromptStashImageUnavailableError extends Error {
  constructor() {
    super("A prompt image is not available on this device yet.");
    this.name = "PromptStashImageUnavailableError";
  }
}

const MAX_INLINE_IMAGE_BASE64_LENGTH =
  Math.ceil((PROMPT_STASH_IMAGE_MAX_BYTES * 4) / 3) + 4;

export type PromptStashImageResolver = (
  hash: string,
) => Promise<ImageBytes | null>;

export async function buildPromptStashSnapshot(args: {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent;
  /**
   * Annotation sidecar records to capture with the prompt. Pass the surface's
   * own records (`[]` for a surface that has none) - this is a required
   * argument rather than an optional one so a new capture site has to decide.
   */
  readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
  readonly readHashImage: PromptStashImageResolver;
}): Promise<PromptStashSnapshot> {
  const imagesByHash = new Map<string, PromptStashImageBlob>();
  // Source hash -> what canonicalization turned it into. Annotation records
  // name a crop by the hash and file name it had in the COMPOSER, and both of
  // those move here: the pipeline re-encodes to a canonical MIME (so the bytes
  // re-hash) and renames the file to match. A record carried across unmapped
  // would point at a blob this entry does not have.
  const canonicalBySourceHash = new Map<string, PreparedOwnedImage>();
  const resolvedSources = new Map<string, Promise<ImageBytes>>();
  const preparedSources = new Map<string, Promise<PreparedOwnedImage>>();
  const preparation = createPromptStashImagePreparationSession(undefined);
  const content = await rewriteImages(args.content, async (attrs) => {
    const inline = stringValue(attrs.b64content);
    const sourceHash = stringValue(attrs.hash);
    if (inline === null && sourceHash === null) {
      throw new Error("A prompt image has no restorable payload.");
    }
    const mimeType = stringValue(attrs.mimeType);
    if (mimeType === null) {
      throw new Error("A prompt image has no MIME type.");
    }
    const sourceKey =
      inline === null ? `hash:${sourceHash}` : `inline:${inline}`;
    let resolved = resolvedSources.get(sourceKey);
    if (resolved === undefined) {
      resolved = resolveImageSource({
        inline,
        sourceHash,
        readHashImage: args.readHashImage,
      });
      resolvedSources.set(sourceKey, resolved);
    }
    const preparationKey = `${sourceKey}\u0000${mimeType.trim().toLowerCase()}`;
    let prepared = preparedSources.get(preparationKey);
    if (prepared === undefined) {
      prepared = resolved.then(async (bytes) => {
        let canonical: PreparedPromptStashImage;
        try {
          canonical = await preparation.prepare({
            bytes,
            fileName: "image",
            declaredMimeType: mimeType,
          });
        } catch (error: unknown) {
          throw new PromptStashImagePreparationError(
            error instanceof Error
              ? error.message
              : "A prompt image could not be prepared for stashing.",
          );
        }
        return {
          bytes: canonical.bytes,
          byteLength: canonical.byteLength,
          hash: await sha256Hex(canonical.bytes),
          mimeType: canonical.mimeType,
        };
      });
      preparedSources.set(preparationKey, prepared);
    }
    const canonical = await prepared;
    imagesByHash.set(canonical.hash, {
      bytes: canonical.bytes,
      mimeType: canonical.mimeType,
    });
    if (sourceHash !== null) canonicalBySourceHash.set(sourceHash, canonical);
    return {
      ...attrs,
      fileName: canonicalPromptStashImageFileName(
        stringValue(attrs.fileName) ?? "image",
        canonical.mimeType,
      ),
      hash: canonical.hash,
      b64content: null,
      mimeType: canonical.mimeType,
      size: canonical.byteLength,
    };
  });
  const annotations = await captureStashAnnotations({
    records: args.annotations,
    canonicalBySourceHash,
    imagesByHash,
    preparation,
    readHashImage: args.readHashImage,
  });
  return {
    entry: {
      id: args.id,
      createdAt: args.createdAt,
      content,
      // After the annotations, because a sidecar-only crop adds a blob.
      blobHashes: Array.from(imagesByHash.keys()),
      annotations,
    },
    imagesByHash,
  };
}

/**
 * Re-point each annotation record at the blob this entry actually owns, and
 * take ownership of a crop the content itself no longer references.
 *
 * Two cases, and the second is the one that is easy to miss. A record whose
 * crop is still in the prompt only needs remapping through canonicalization.
 * A SIDECAR-ONLY record - the user deleted the image from the prompt but kept
 * the annotation, or the surface holds the record beside content that never
 * inlined it - has no node to ride along with, so its bytes are resolved and
 * stored here or the record is not carried at all.
 *
 * A record whose bytes cannot be resolved is DROPPED rather than throwing. The
 * prompt is the thing being saved; refusing to stash a page of text because a
 * crop that is no longer in it has been reclaimed would be the worse failure.
 */
async function captureStashAnnotations(args: {
  readonly records: ReadonlyArray<BrowserAnnotationRecord>;
  readonly canonicalBySourceHash: ReadonlyMap<string, PreparedOwnedImage>;
  readonly imagesByHash: Map<string, PromptStashImageBlob>;
  readonly preparation: PromptStashImagePreparationSession;
  readonly readHashImage: PromptStashImageResolver;
}): Promise<BrowserAnnotationRecord[]> {
  const captured: BrowserAnnotationRecord[] = [];
  const sidecars = new Map<string, PreparedOwnedImage | null>();
  for (const record of args.records) {
    let canonical = args.canonicalBySourceHash.get(record.imageHash) ?? null;
    if (canonical === null) {
      if (!sidecars.has(record.imageHash)) {
        sidecars.set(
          record.imageHash,
          await prepareSidecarCrop(
            record.imageHash,
            args.preparation,
            args.readHashImage,
          ),
        );
      }
      canonical = sidecars.get(record.imageHash) ?? null;
      if (canonical !== null) {
        args.imagesByHash.set(canonical.hash, {
          bytes: canonical.bytes,
          mimeType: canonical.mimeType,
        });
      }
    }
    if (canonical === null) continue;
    captured.push({
      ...record,
      imageHash: canonical.hash,
      imageFileName: canonicalPromptStashImageFileName(
        record.imageFileName,
        canonical.mimeType,
      ),
    });
  }
  return captured;
}

/**
 * Resolve and canonicalize a crop that only an annotation record names.
 * `null` when the bytes are gone, unreadable, or not a recognizable image -
 * the record is then dropped rather than left pointing at nothing.
 */
async function prepareSidecarCrop(
  hash: string,
  preparation: PromptStashImagePreparationSession,
  readHashImage: PromptStashImageResolver,
): Promise<PreparedOwnedImage | null> {
  try {
    const bytes = await readHashImage(hash);
    if (bytes === null) return null;
    // The record carries no MIME, so the bytes have to say what they are.
    const sniffed = sniffImageMimeType(bytes);
    if (sniffed === null) return null;
    const canonical = await preparation.prepare({
      bytes,
      fileName: "annotation",
      declaredMimeType: sniffed,
    });
    return {
      bytes: canonical.bytes,
      byteLength: canonical.byteLength,
      hash: await sha256Hex(canonical.bytes),
      mimeType: canonical.mimeType,
    };
  } catch {
    return null;
  }
}

async function resolveImageSource(args: {
  readonly inline: string | null;
  readonly sourceHash: string | null;
  readonly readHashImage: PromptStashImageResolver;
}): Promise<ImageBytes> {
  if (args.inline !== null) {
    if (args.inline.length > MAX_INLINE_IMAGE_BASE64_LENGTH) {
      throw new Error("A prompt image is over the 5 MB limit.");
    }
    const bytes = base64ToBytes(args.inline);
    if (bytes === null) {
      throw new Error("A prompt image contains invalid base64 data.");
    }
    return bytes;
  }
  if (args.sourceHash === null) {
    throw new Error("A prompt image has no restorable payload.");
  }
  const bytes = await args.readHashImage(args.sourceHash);
  if (bytes === null) {
    throw new PromptStashImageUnavailableError();
  }
  return bytes;
}

/**
 * Put an entry's annotation crops back into this window's image partition,
 * under the same hashes their records name.
 *
 * Restoring the RECORDS without the bytes would hand the composer a set of
 * annotations pointing at nothing: the stash's blob table is the only place
 * those bytes live while the entry is stashed, and the hook deletes the entry
 * the moment insertion is accepted. Writing them here - before the insert, and
 * so before the consume - is what makes a restored annotation a working chip
 * rather than a broken one.
 *
 * Best effort per crop. A blob that has gone missing or fails its digest costs
 * that one annotation its image, not the restore.
 */
export async function restorePromptStashAnnotationCrops(
  annotations: ReadonlyArray<BrowserAnnotationRecord>,
): Promise<void> {
  const hashes = [...new Set(annotations.map((record) => record.imageHash))];
  if (hashes.length === 0) return;
  const read = await readPromptStashRestoreBlobs(hashes);
  if (read.status !== "ok") return;
  for (const hash of hashes) {
    const blob = read.blobs.get(hash);
    if (blob === undefined) continue;
    await putImageBytesAtHash(hash, blob.bytes);
  }
}

export async function materializePromptStashEntry(
  entry: PromptStashEntry,
): Promise<JsonContent> {
  // One consistent-snapshot read of every referenced blob up front: bytes
  // resolved here stay valid even if another window deletes/reclaims them
  // immediately after, and a missing OR corrupt blob fails the whole restore
  // before any node is rewritten.
  const read = await readPromptStashRestoreBlobs(entry.blobHashes);
  if (read.status === "missing") throw new PromptStashMissingBlobError();
  if (read.status === "corrupt") throw new PromptStashCorruptBlobError();
  const blobs = read.blobs;
  return rewriteImages(entry.content, (attrs) => {
    const hash = stringValue(attrs.hash);
    if (hash === null) {
      throw new Error("A stashed image has no content hash.");
    }
    const blob = blobs.get(hash);
    if (blob === undefined) {
      throw new PromptStashMissingBlobError();
    }
    // The node's own declared MIME/size can diverge from what the verified
    // blob actually is (the entry and its blob store having drifted apart) -
    // a SHA-256 match alone would not catch this. Metadata disagreement is
    // corruption: preserve the stash rather than materialize mismatched
    // content.
    if (
      !stashImageMetadataAgreesWithBlob(
        stringValue(attrs.mimeType),
        numberValue(attrs.size),
        blob,
      )
    ) {
      throw new PromptStashCorruptBlobError();
    }
    return Promise.resolve({
      ...attrs,
      id: crypto.randomUUID(),
      b64content: bytesToBase64(blob.bytes),
      hash: null,
    });
  });
}

/**
 * Empty destinations receive the restored document unchanged. Non-empty
 * destinations retain their existing blocks and append the restored document
 * after one separator paragraph. Selection/caret behavior is intentionally
 * owned by the destination adapter, which always focuses the resulting end.
 */
export function appendPromptStashContent(
  current: JsonContent,
  restored: JsonContent,
): JsonContent {
  if (!hasVisibleComposerContent(current)) return restored;
  if (!hasVisibleComposerContent(restored)) return current;
  return {
    ...current,
    type: "doc",
    content: [
      ...withoutTrailingEmptyParagraph(current.content ?? []),
      { type: "paragraph" },
      ...(restored.content ?? []),
    ],
  };
}

function withoutTrailingEmptyParagraph(
  blocks: ReadonlyArray<JsonContent>,
): JsonContent[] {
  const last = blocks.at(-1);
  if (
    last?.type === "paragraph" &&
    (last.content === undefined || last.content.length === 0)
  ) {
    return blocks.slice(0, -1);
  }
  return [...blocks];
}

async function rewriteImages(
  node: JsonContent,
  rewrite: (
    attrs: Readonly<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>,
): Promise<JsonContent> {
  const attrs =
    node.type === "imageAttachment"
      ? await rewrite(node.attrs ?? {})
      : node.attrs;
  let content: JsonContent[] | undefined;
  if (node.content !== undefined) {
    content = [];
    for (const child of node.content) {
      content.push(await rewriteImages(child, rewrite));
    }
  }
  return {
    ...node,
    ...(attrs === undefined ? {} : { attrs }),
    ...(content === undefined ? {} : { content }),
  };
}

function hasVisibleComposerContent(content: JsonContent): boolean {
  return (content.content ?? []).some(hasVisibleNodeContent);
}

function hasVisibleNodeContent(node: JsonContent): boolean {
  if (node.type === "text") return (node.text ?? "").length > 0;
  if (node.type === "imageAttachment") return true;
  if (node.type === "mention" || node.type === "slashCommand") return true;
  return (node.content ?? []).some(hasVisibleNodeContent);
}

async function sha256Hex(bytes: ImageBytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
