/**
 * Shared server-frame schema for the image "asset stream" methods -
 * `workspace.streamAsset` and `git.streamFileAsset`. Both fetch a file's raw
 * bytes as one of the five supported image formats (PNG, JPEG, GIF, WebP,
 * SVG) and stream the same four-frame sequence, so the frame shape lives
 * here once instead of duplicated per method:
 *
 *   `assetHeader` -> N x `assetChunk` -> `assetComplete`
 *
 * or `assetError` in place of the header when host-side validation fails
 * (containment, extension allowlist, magic-byte mismatch, size/pixel caps).
 * See the image-preview tech plan ("Transport verdict") for why this rides
 * the stream transport - chunked binary frames, not a unary base64 response
 * bound by the mux's 1 MiB frame cap.
 *
 * Neither method takes application client frames: these are server-push-only
 * streams opened for one fetch and then closed by the caller. The client
 * frame schema still declares `ping` - `WsStreamClient`'s wire-level
 * heartbeat constructs `ping`/`pong` frames unconditionally on a timer
 * without validating them against the active contract's schema, but every
 * other stream contract in this registry declares the pair for the same
 * reason (see `migration.run`, `worktree.deleteByPath`), so this follows
 * that precedent rather than being the first exception.
 */
import { z } from "zod";

export const assetMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
export type AssetMediaType = z.infer<typeof assetMediaTypeSchema>;

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

export const assetStreamServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assetHeader"),
    hasBinaryPayload: z.literal(false),
    // Host-authoritative, derived from magic bytes - never trusted from the
    // requested file's extension.
    mediaType: assetMediaTypeSchema,
    sizeBytes: z.number().int().nonnegative(),
    // `null` only for SVG without declared dimensions - no binary magic
    // exists for SVG, and not every SVG declares a width/height/viewBox.
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
