/**
 * Shared server-frame schema for the "asset stream" methods -
 * `workspace.streamAsset` and `git.streamFileAsset`. Both fetch a file's raw
 * bytes as one of the supported preview formats (five image formats - PNG,
 * JPEG, GIF, WebP, SVG - plus PDF since 1.1) and stream the same four-frame
 * sequence, so the frame shape lives here once instead of duplicated per
 * method:
 *
 *   `assetHeader` -> N x `assetChunk` -> `assetComplete`
 *
 * or `assetError` in place of the header when host-side validation fails
 * (containment, extension allowlist, magic-byte mismatch, size/pixel caps).
 * See the image-preview tech plan ("Transport verdict") for why this rides
 * the stream transport - chunked binary frames, not a unary base64 response
 * bound by the mux's 1 MiB frame cap.
 *
 * Neither method takes application client frames (server-push-only, opened
 * for one fetch and closed by the caller) - the client frame schema still
 * declares `ping`, matching every other stream contract in this registry.
 */
import { z } from "zod";

/**
 * Hard cap on a single asset's byte size, shared by the host (admission +
 * `validateAssetBytes`) and every client (`AssetStreamClient`'s cumulative
 * budget) - one constant so raising or lowering it can't drift between the
 * side that enforces it and the side that bounds its own buffering to it.
 */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * The 1.0 media-type set - FROZEN: 1.0 is released, so this enum can never
 * change again (the compat gate diffs released wire schemas literally).
 * `epic.readChatAttachment` and the artifact-attachment response reuse it,
 * which is exactly right: attachments are an image-only channel.
 */
export const assetMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/**
 * The 1.1 media-type set: PDF joins the five image formats. A separate
 * schema object rather than a widening of the 1.0 enum, so each released
 * minor keeps its exact wire schema (a 1.0 parse must keep REJECTING
 * `application/pdf` - a 1.0 client's copy of the enum predates the
 * literal). The host's resolvers additionally gate admission and emission
 * on the negotiated minor, so the new literal never reaches a 1.0 peer.
 */
export const assetMediaTypeSchemaV11 = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
]);

/** Application-facing media type: the LATEST minor's set. */
export type AssetMediaType = z.infer<typeof assetMediaTypeSchemaV11>;

export const assetStreamErrorReasonSchema = z.enum([
  "not-found",
  // Historical name, kept as the wire literal forever: it means "not a
  // supported asset type" (since 1.1 that set includes PDF, so a PDF
  // request on a 1.0-negotiated stream also lands here). Renaming would be
  // a breaking change for every shipped client's parser; display copy owns
  // the honest phrasing.
  "not-image",
  "mismatch",
  "too-large",
  "too-many-pixels",
  "read-failed",
]);
export type AssetStreamErrorReason = z.infer<
  typeof assetStreamErrorReasonSchema
>;

/**
 * `assetHeader` fields shared by every minor except the media-type set,
 * which is per-version (see the enum pair above).
 */
const assetHeaderFrameFields = {
  kind: z.literal("assetHeader"),
  hasBinaryPayload: z.literal(false),
  sizeBytes: z.number().int().nonnegative(),
  // `null` when the asset has no known intrinsic raster dimensions: an
  // SVG that declares no width/height/viewBox, or a non-raster document
  // (PDF - pages have geometry, but the client learns it from the bytes;
  // the host stays a validate-and-stream layer and parses no documents).
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  // The git OID for an object side, else a `size:mtimeMs` fingerprint for
  // a worktree file - the blob-cache key's identity component.
  contentIdentity: z.string(),
};

const assetChunkFrameSchema = z.object({
  kind: z.literal("assetChunk"),
  hasBinaryPayload: z.literal(true),
  index: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
});

const assetCompleteFrameSchema = z.object({
  kind: z.literal("assetComplete"),
  hasBinaryPayload: z.literal(false),
});

const assetErrorFrameSchema = z.object({
  kind: z.literal("assetError"),
  hasBinaryPayload: z.literal(false),
  error: z.string(),
  reason: assetStreamErrorReasonSchema,
});

const pongFrameSchema = z.object({
  kind: z.literal("pong"),
  hasBinaryPayload: z.literal(false),
});

/** The FROZEN 1.0 server-frame union: image media types only. */
export const assetStreamServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    ...assetHeaderFrameFields,
    // Host-authoritative, derived from magic bytes - never trusted from the
    // requested file's extension.
    mediaType: assetMediaTypeSchema,
  }),
  assetChunkFrameSchema,
  assetCompleteFrameSchema,
  assetErrorFrameSchema,
  pongFrameSchema,
]);

/** The 1.1 server-frame union: identical shape, PDF-capable media type. */
export const assetStreamServerFrameSchemaV11 = z.discriminatedUnion("kind", [
  z.object({
    ...assetHeaderFrameFields,
    mediaType: assetMediaTypeSchemaV11,
  }),
  assetChunkFrameSchema,
  assetCompleteFrameSchema,
  assetErrorFrameSchema,
  pongFrameSchema,
]);

/** Application-facing frame type: the LATEST minor's shape. */
export type AssetStreamServerFrame = z.infer<
  typeof assetStreamServerFrameSchemaV11
>;

export const assetStreamClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ping"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type AssetStreamClientFrame = z.infer<
  typeof assetStreamClientFrameSchema
>;
