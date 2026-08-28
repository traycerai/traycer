/**
 * Pure persisted-record codec/validator for the prompt stash: converts raw
 * IndexedDB values (entry records and blob records) into the repository's
 * typed rows/blobs, with no IndexedDB access of its own. The repository
 * (`prompt-stash-repository.ts`) owns transactions and calls into this
 * module to interpret what a transaction reads; this module never opens a
 * database or a transaction itself.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { isJsonContent } from "@/lib/editor/prosemirror-json";

import {
  CANONICAL_IMAGE_MIME_TYPES,
  sniffImageMimeType,
} from "@/lib/composer/prompt-stash-image-signature";
import {
  KNOWN_STASH_MARK_TYPES,
  KNOWN_STASH_NODE_TYPES,
} from "@/lib/composer/prompt-stash-schema-descriptor";

type ImageBytes = Uint8Array<ArrayBuffer>;

export interface PromptStashEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent;
  /**
   * Authoritative reference list for this entry's image blobs, captured once
   * at save time from the image-preparation pipeline's own bookkeeping - not
   * re-derived from Tiptap content. Every repository operation that needs to
   * know what an entry references (save, delete, restore) reads this field
   * rather than re-parsing `content`.
   */
  readonly blobHashes: readonly string[];
}

/** Bytes plus the canonical MIME the image-preparation pipeline resolved for them. */
export interface PromptStashImageBlob {
  readonly bytes: ImageBytes;
  readonly mimeType: string;
}

export interface PromptStashSnapshot {
  readonly entry: PromptStashEntry;
  readonly imagesByHash: ReadonlyMap<string, PromptStashImageBlob>;
}

export interface PromptStashRestoreBlob {
  readonly bytes: ImageBytes;
  readonly byteLength: number;
  readonly mimeType: string;
}

/**
 * A raw stored record that failed validation - a malformed shape, an image
 * node whose stash-hash reference isn't in `blobHashes`, or a referenced blob
 * missing from the `blobs` store. Never dropped from the manifest: the
 * repository's contract is that every identifiable stored record surfaces as
 * a row, restorable or not, so the UI can show it, delete it, and best-effort
 * copy its text - never silently hide or auto-consume it.
 *
 * `content` is carried through whenever the record's own JSON tree still
 * parses as a doc, even if what makes the row unavailable is something else
 * (a missing blob or unparseable `blobHashes`) - that
 * is what makes best-effort text recovery possible. It is `null` only when
 * the stored record's `content` itself doesn't parse.
 */
export interface PromptStashUnavailableRow {
  readonly kind: "unavailable";
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent | null;
}

export interface PromptStashAvailableRow {
  readonly kind: "entry";
  readonly entry: PromptStashEntry;
}

export type PromptStashRow =
  | PromptStashAvailableRow
  | PromptStashUnavailableRow;

export function promptStashRowId(row: PromptStashRow): string {
  return row.kind === "entry" ? row.entry.id : row.id;
}

export function promptStashRowCreatedAt(row: PromptStashRow): number {
  return row.kind === "entry" ? row.entry.createdAt : row.createdAt;
}

export interface PromptStashManifest {
  readonly rows: ReadonlyArray<PromptStashRow>;
  readonly revision: number;
}

/**
 * `readPromptStashRestoreBlobs` result. `"missing"` covers both a genuinely
 * absent blob and the general "could not resolve every referenced byte"
 * case; `"corrupt"` means every referenced blob exists but at least one
 * fails runtime-type, measured-length, canonical-MIME, or SHA-256 validation
 * - distinguished from `"missing"` so restore/materialize can report "this
 * image is damaged" rather than "not synced yet".
 */
export type PromptStashRestoreRead =
  | {
      readonly status: "ok";
      readonly blobs: ReadonlyMap<string, PromptStashRestoreBlob>;
    }
  | { readonly status: "missing" }
  | { readonly status: "corrupt" };

/** Raw shape of a stored `blobs` record, as the repository's transactions read/write it. */
export interface StashBlobRecord {
  readonly hash: string;
  readonly bytes: ImageBytes;
  readonly byteLength: number;
  readonly mimeType: string;
}

export function newestFirstRow(a: PromptStashRow, b: PromptStashRow): number {
  return promptStashRowCreatedAt(b) - promptStashRowCreatedAt(a);
}

/**
 * Everything this codec can recover from a raw stored record, however
 * broken - used to keep save/delete/load tolerant of a corrupt
 * sibling and to build the visible `PromptStashUnavailableRow` when the
 * record itself doesn't fully validate.
 */
export interface RawStashRecordInfo {
  readonly id: string;
  readonly createdAt: number;
  /** Best-effort: `[]` when the raw `blobHashes` field itself doesn't parse. */
  readonly blobHashes: readonly string[];
  /** Non-null iff the record is fully valid and safe to use for save/restore. */
  readonly entry: PromptStashEntry | null;
  /** Best-effort: the record's own content tree, whenever IT parses - independent of overall entry validity, so a blob-incomplete (but structurally fine) entry can still offer text-copy. */
  readonly bestEffortContent: JsonContent | null;
}

/**
 * Parses a raw IndexedDB record with no assumption that it is well-formed.
 * Returns `null` only when the record has no recoverable identity at all (no
 * string `id`) - which should not happen given `entries`' `id` keyPath, but
 * is handled defensively rather than assumed. Every other field degrades to
 * a best-effort value instead of failing the whole record, so a single
 * broken field never makes an otherwise-identifiable row disappear.
 */
export function inspectRawStashRecord(
  value: unknown,
): RawStashRecordInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  const blobHashes = isBlobHashesArray(value.blobHashes)
    ? value.blobHashes
    : [];
  const bestEffortContent =
    isJsonContent(value.content, 0) && value.content.type === "doc"
      ? value.content
      : null;
  // The full validity condition is written directly as the ternary test so
  // TypeScript narrows `bestEffortContent` in the object literal below.
  const entry: PromptStashEntry | null =
    bestEffortContent !== null &&
    isCanonicalStashBlobHashesArray(value.blobHashes) &&
    isRestorableStashContentTree(bestEffortContent, new Set(blobHashes))
      ? {
          id: value.id,
          createdAt,
          content: bestEffortContent,
          blobHashes,
        }
      : null;
  return { id: value.id, createdAt, blobHashes, entry, bestEffortContent };
}

/**
 * `info.entry` is only ever non-null when the record fully validated
 * structurally; this additionally requires every referenced blob to still be
 * PRESENT (not necessarily byte-valid - that is checked lazily on restore).
 * A structurally-valid entry with a missing blob still carries its
 * `bestEffortContent` through to the unavailable row.
 */
export function toPromptStashRow(
  info: RawStashRecordInfo,
  presentBlobHashes: ReadonlySet<string>,
): PromptStashRow {
  if (
    info.entry !== null &&
    info.blobHashes.every((hash) => presentBlobHashes.has(hash))
  ) {
    return { kind: "entry", entry: info.entry };
  }
  return {
    kind: "unavailable",
    id: info.id,
    createdAt: info.createdAt,
    content: info.bestEffortContent,
  };
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function hasOnlyKnownStashMarks(marks: JsonContent["marks"]): boolean {
  if (marks === undefined) return true;
  return marks.every((mark) => KNOWN_STASH_MARK_TYPES.has(mark.type));
}

/**
 * The full restore-critical attr contract for a stash-owned `imageAttachment`
 * node: non-empty `id`/`fileName`, a canonical MIME, a measured positive
 * integer `size`, no inline `b64content` (a persisted stash entry only ever
 * owns its images through the `blobs` store), and exactly one canonical
 * lowercase SHA-256 `hash` that this entry actually declares in
 * `blobHashes`. Returns the validated hash (not just a boolean) so the
 * caller can accumulate it without re-reading/re-casting `attrs`.
 */
function validStashImageHash(
  attrs: unknown,
  blobHashes: ReadonlySet<string>,
): string | null {
  if (!isRecord(attrs)) return null;
  if (typeof attrs.id !== "string" || attrs.id.length === 0) return null;
  if (typeof attrs.fileName !== "string" || attrs.fileName.length === 0) {
    return null;
  }
  if (
    typeof attrs.mimeType !== "string" ||
    !CANONICAL_IMAGE_MIME_TYPES.has(attrs.mimeType)
  ) {
    return null;
  }
  if (
    typeof attrs.size !== "number" ||
    !Number.isInteger(attrs.size) ||
    attrs.size <= 0
  ) {
    return null;
  }
  if (attrs.b64content !== undefined && attrs.b64content !== null) {
    return null;
  }
  if (typeof attrs.hash !== "string" || !SHA256_HEX_PATTERN.test(attrs.hash)) {
    return null;
  }
  return blobHashes.has(attrs.hash) ? attrs.hash : null;
}

/**
 * Recursive pass over one candidate restorable tree: every node/mark type
 * must be one `KNOWN_STASH_NODE_TYPES`/`KNOWN_STASH_MARK_TYPES` recognizes,
 * and every `imageAttachment` node must resolve a `validStashImageHash`.
 * Accumulates the set of image hashes actually referenced by content into
 * `used`, so the caller can check it against the declared `blobHashes`
 * afterward. A node that fails any of this makes the whole entry
 * unrestorable rather than silently dropping just that node.
 */
function collectStashImageHashes(
  node: JsonContent,
  blobHashes: ReadonlySet<string>,
  used: Set<string>,
): boolean {
  if (node.type === undefined || !KNOWN_STASH_NODE_TYPES.has(node.type)) {
    return false;
  }
  if (!hasOnlyKnownStashMarks(node.marks)) return false;
  if (node.type === "imageAttachment") {
    const hash = validStashImageHash(node.attrs, blobHashes);
    if (hash === null) return false;
    used.add(hash);
  }
  const content = node.content;
  if (content === undefined) return true;
  return content.every((child) =>
    collectStashImageHashes(child, blobHashes, used),
  );
}

/**
 * A tree is restorable only when `collectStashImageHashes` accepts every
 * node/mark and image attr AND the set of image hashes actually referenced
 * by content exactly equals the declared `blobHashes` - no hash kept alive
 * that nothing references, no reference to a hash the entry never declared.
 * `used` is only ever built from hashes already confirmed to be IN
 * `blobHashes` (see `validStashImageHash`), so `used` is always a subset;
 * equal size is therefore sufficient to prove equal sets.
 */
function isRestorableStashContentTree(
  node: JsonContent,
  blobHashes: ReadonlySet<string>,
): boolean {
  const used = new Set<string>();
  if (!collectStashImageHashes(node, blobHashes, used)) return false;
  return used.size === blobHashes.size;
}

async function sha256Hex(bytes: ImageBytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Realm-safe Uint8Array check. IndexedDB structured clone (and fake-indexeddb
 * under jsdom) can yield a same-shape view whose prototype is not the current
 * realm's `Uint8Array`, so plain `instanceof` would false-negative a real
 * byte view and mark every restore as corrupt.
 */
export function isUint8ArrayBytes(value: unknown): value is ImageBytes {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

/**
 * Runtime type, measured length, canonical MIME, MIME-vs-signature
 * agreement, and SHA-256 agreement - the checks the governing architecture
 * calls out for blob-level corruption. Called only on an actual restore
 * attempt (see `prompt-stash-repository.ts`'s `readPromptStashRestoreBlobs`),
 * never on every load.
 */
export async function isValidStashBlobRecord(
  hash: string,
  record: StashBlobRecord,
): Promise<boolean> {
  if (!isUint8ArrayBytes(record.bytes)) return false;
  if (record.bytes.byteLength === 0) return false;
  if (record.bytes.byteLength !== record.byteLength) return false;
  if (!CANONICAL_IMAGE_MIME_TYPES.has(record.mimeType)) return false;
  if (sniffImageMimeType(record.bytes) !== record.mimeType) return false;
  return (await sha256Hex(record.bytes)) === hash;
}

/**
 * Whether an image node's declared `mimeType`/`size` agree with the ACTUAL
 * verified blob resolved for its hash. A stash entry can pass structural
 * validation from its own declared attrs alone (`validStashImageHash`); this
 * additionally catches the entry and its blob store having diverged - e.g.
 * the same hash stored under a different MIME/size than the node declares -
 * which neither the node's own attr shape nor the blob's SHA-256/signature
 * checks alone would catch, since a hash only proves the bytes weren't
 * tampered with, not that the node describing them agrees with what they
 * actually are. Called before generic (chat/modal) materialization and
 * before landing adoption; a disagreement is corruption and must preserve
 * the stash rather than insert/consume mismatched content.
 */
export function stashImageMetadataAgreesWithBlob(
  declaredMimeType: string | null,
  declaredSize: number | null,
  blob: PromptStashRestoreBlob,
): boolean {
  return declaredMimeType === blob.mimeType && declaredSize === blob.byteLength;
}

function isBlobHashesArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * The stricter contract `blobHashes` must meet for an entry to count as
 * fully restorable: every element is a canonical lowercase SHA-256 hex
 * string, and there are no duplicates. `isBlobHashesArray` above stays loose
 * (any string array) because save/delete deliberately track a corrupt
 * record's best-effort `blobHashes` too - this stricter check only gates
 * whether the record is a restorable `entry`, not whether its referenced
 * blobs stay alive.
 */
function isCanonicalStashBlobHashesArray(
  value: unknown,
): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  if (
    !value.every(
      (item): item is string =>
        typeof item === "string" && SHA256_HEX_PATTERN.test(item),
    )
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
