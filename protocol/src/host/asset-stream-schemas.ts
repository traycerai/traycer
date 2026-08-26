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

export const assetMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Added in 1.1. A host must never emit it on a 1.0-negotiated stream: a
  // 1.0 client's copy of this enum predates the literal, so the whole
  // header frame would fail its parse. The resolvers gate admission and
  // emission on the negotiated minor for exactly this reason.
  "application/pdf",
]);
export type AssetMediaType = z.infer<typeof assetMediaTypeSchema>;

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

export const assetStreamServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assetHeader"),
    hasBinaryPayload: z.literal(false),
    // Host-authoritative, derived from magic bytes - never trusted from the
    // requested file's extension.
    mediaType: assetMediaTypeSchema,
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
  }),
  z.object({
    kind: z.literal("assetChunk"),
    hasBinaryPayload: z.literal(true),
    index: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("assetComplete"),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("assetError"),
    hasBinaryPayload: z.literal(false),
    error: z.string(),
    reason: assetStreamErrorReasonSchema,
  }),
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type AssetStreamServerFrame = z.infer<
  typeof assetStreamServerFrameSchema
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
