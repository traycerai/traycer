import { z } from "zod";
import { assetMediaTypeSchema } from "@traycer/protocol/host/asset-stream-schemas";
import { imageSha256HexSchema } from "@traycer/protocol/persistence/epic/images";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Read attachment bytes that are still canonically stored in the epic root
 * document without putting that document on the @2 stream.
 *
 * `artifactId`, together with `epicId`, names the authorization subject. A
 * SHA-256 hash is only a content address: accepting one without first proving
 * access to the referenced artifact would turn an otherwise harmless cache key
 * into an authorization capability.
 */
export const fetchArtifactAttachmentRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    artifactId: z.string().min(1),
    hash: imageSha256HexSchema,
  }),
);
export type FetchArtifactAttachmentRequest = z.infer<
  typeof fetchArtifactAttachmentRequestSchema
>;

export const fetchArtifactAttachmentFoundSchema = lazySchema(() =>
  z.object({
    ok: z.literal(true),
    /**
     * Base64 of the raw bytes addressed by `hash` - VALIDATED as Base64, not
     * merely documented: the client decodes this blind, and a host bug that
     * ships a non-Base64 string should fail the RPC envelope, not surface as
     * a corrupt image downstream.
     */
    bytesBase64: z.base64(),
    /**
     * HOST-AUTHORITATIVE, derived from the delivered bytes' magic bytes - never
     * echoed from a document-authored media type or inferred from a filename.
     * Reusing the asset-stream enum keeps the byte channels' supported renderer
     * formats in lockstep.
     */
    mediaType: assetMediaTypeSchema,
  }),
);
export type FetchArtifactAttachmentFound = z.infer<
  typeof fetchArtifactAttachmentFoundSchema
>;

/**
 * An absent attachment is data, not an RPC failure. "Not published", "not
 * permitted", "no such artifact", and missing bytes deliberately share this
 * result so callers cannot use the method to enumerate attachments outside an
 * artifact they may read. Transient failures remain RPC errors so clients retry
 * rather than cache a permanent unavailable result.
 *
 * While the host is still fetching the bytes, a `1.1` caller is answered
 * {@link fetchArtifactAttachmentDownloadingSchema} and a `1.0` caller this.
 */
export const fetchArtifactAttachmentMissingSchema = lazySchema(() =>
  z.object({
    ok: z.literal(false),
    reason: z.literal("missing"),
  }),
);
export type FetchArtifactAttachmentMissing = z.infer<
  typeof fetchArtifactAttachmentMissingSchema
>;

/**
 * `1.1`: the artifact may read these bytes and the host is fetching them now.
 * Asking again later can return `found`. Only an artifact the caller may read
 * gets this answer, so it reveals nothing `missing` hides.
 */
export const fetchArtifactAttachmentDownloadingSchema = lazySchema(() =>
  z
    .object({
      ok: z.literal(false),
      reason: z.literal("downloading"),
      receivedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    })
    .refine((progress) => progress.receivedBytes <= progress.totalBytes, {
      message: "Received bytes must not exceed total bytes",
      path: ["receivedBytes"],
    }),
);
export type FetchArtifactAttachmentDownloading = z.infer<
  typeof fetchArtifactAttachmentDownloadingSchema
>;

/** Frozen: the `1.0` response. */
export const fetchArtifactAttachmentResponseSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("ok", [
    fetchArtifactAttachmentFoundSchema,
    fetchArtifactAttachmentMissingSchema,
  ]),
);
export type FetchArtifactAttachmentResponseV10 = z.infer<
  typeof fetchArtifactAttachmentResponseSchemaV10
>;

/**
 * `1.1`, the head: `ok` stays the outer discriminant, and `reason` tells the
 * two `ok: false` answers apart.
 */
export const fetchArtifactAttachmentResponseSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    fetchArtifactAttachmentFoundSchema,
    z.discriminatedUnion("reason", [
      fetchArtifactAttachmentMissingSchema,
      fetchArtifactAttachmentDownloadingSchema,
    ]),
  ]),
);
export type FetchArtifactAttachmentResponse = z.infer<
  typeof fetchArtifactAttachmentResponseSchema
>;

/**
 * Serve a head answer to a caller that negotiated `1.0`, whose schema rejects
 * `downloading` outright. Host dispatch runs this before the caller's parse;
 * the registry's `responseGrowthProjectionGated` on `1.1` is the claim that it
 * does. `downloading` reads as `missing`, which is what a `1.0` caller was
 * answered for bytes the host did not hold yet.
 */
export function projectEpicFetchArtifactAttachmentResponseToV10(
  response: FetchArtifactAttachmentResponse,
): FetchArtifactAttachmentResponseV10 {
  if (response.ok) return response;
  return { ok: false, reason: "missing" };
}
