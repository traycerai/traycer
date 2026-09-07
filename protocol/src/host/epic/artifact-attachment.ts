import { z } from "zod";
import { assetMediaTypeSchema } from "@traycer/protocol/host/asset-stream-schemas";
import { imageSha256HexSchema } from "@traycer/protocol/persistence/epic/images";

/**
 * Read attachment bytes that are still canonically stored in the epic root document without putting that document on the @2 stream.
 */
export const fetchArtifactAttachmentRequestSchema = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
  hash: imageSha256HexSchema,
});
export type FetchArtifactAttachmentRequest = z.infer<
  typeof fetchArtifactAttachmentRequestSchema
>;

export const fetchArtifactAttachmentFoundSchema = z.object({
  ok: z.literal(true),
  bytesBase64: z.base64(),
  /**
   * HOST-AUTHORITATIVE, derived from the delivered bytes' magic bytes - never echoed from a document-authored media type or inferred from a filename.
   */
  mediaType: assetMediaTypeSchema,
});
export type FetchArtifactAttachmentFound = z.infer<
  typeof fetchArtifactAttachmentFoundSchema
>;

/**
 * An absent attachment is data, not an RPC failure.
 * "Not published", "not permitted", "no such artifact", and missing bytes deliberately share this result so callers cannot use the method to enumerate attachments outside an artifact they may read.
 */
export const fetchArtifactAttachmentMissingSchema = z.object({
  ok: z.literal(false),
  reason: z.literal("missing"),
});
export type FetchArtifactAttachmentMissing = z.infer<
  typeof fetchArtifactAttachmentMissingSchema
>;

export const fetchArtifactAttachmentResponseSchema = z.discriminatedUnion(
  "ok",
  [fetchArtifactAttachmentFoundSchema, fetchArtifactAttachmentMissingSchema],
);
export type FetchArtifactAttachmentResponse = z.infer<
  typeof fetchArtifactAttachmentResponseSchema
>;
