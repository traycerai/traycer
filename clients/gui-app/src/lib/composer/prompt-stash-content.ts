import type { JsonContent } from "@traycer/protocol/common/registry";

import { base64ToBytes, bytesToBase64 } from "@/lib/composer/image-base64";
import {
  canonicalPromptStashImageFileName,
  createPromptStashImagePreparationSession,
  PROMPT_STASH_IMAGE_MAX_BYTES,
  type CanonicalImageMimeType,
  type PreparedPromptStashImage,
} from "@/lib/composer/prompt-stash-image-preparation";
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

type ImageBytes = Uint8Array<ArrayBuffer>;

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
  readonly readHashImage: PromptStashImageResolver;
}): Promise<PromptStashSnapshot> {
  const imagesByHash = new Map<string, PromptStashImageBlob>();
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
  return {
    entry: {
      id: args.id,
      createdAt: args.createdAt,
      content,
      blobHashes: Array.from(imagesByHash.keys()),
    },
    imagesByHash,
  };
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
