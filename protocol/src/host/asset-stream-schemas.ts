import { z } from "zod";

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * The 1.0 media-type set - FROZEN: 1.0 is released, so this enum can never change again (the compat gate diffs released wire schemas literally).
 */
export const assetMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/**
 * The 1.1 media-type set: PDF joins the five image formats.
 * The host's resolvers additionally gate admission and emission on the negotiated minor, so the new literal never reaches a 1.0 peer.
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
