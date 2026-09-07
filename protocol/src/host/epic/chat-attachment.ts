import { z } from "zod";

import { assetMediaTypeSchema } from "@traycer/protocol/host/asset-stream-schemas";

/**
 * Host <-> client wire shape for reading ONE chat image attachment's bytes.
 * Registered `degrade: { kind: "unsupported" }` and NOT on the released floor - a new method NAME is handshake-fatal against a released peer.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const readChatAttachmentRequestSchema = z.object({
  epicId: z.string().min(1),
  /**
   * The chat that REFERENCES the attachment - the authorization subject, not a lookup key.
   * See the visibility argument above: without it the host cannot gate a local-store hit, and a content address alone would leak private-chat bytes to any epic participant.
   */
  chatId: z.string().min(1),
  /** Content address of the image bytes. */
  hash: sha256HexSchema,
});
export type ReadChatAttachmentRequest = z.infer<
  typeof readChatAttachmentRequestSchema
>;

export const readChatAttachmentFoundSchema = z.object({
  ok: z.literal(true),
  /** Base64 of the RAW image bytes - what `hash` is over. */
  bytesBase64: z.string(),
  /**
   * HOST-AUTHORITATIVE, derived from the delivered bytes' magic bytes - never echoed from a client-declared media type and never inferred from a file extension.
   */
  mediaType: assetMediaTypeSchema,
});
export type ReadChatAttachmentFound = z.infer<
  typeof readChatAttachmentFoundSchema
>;

/** The bytes are not obtainable, and this is DATA rather than a throw. */
export const readChatAttachmentMissingSchema = z.object({
  ok: z.literal(false),
  reason: z.literal("missing"),
});
export type ReadChatAttachmentMissing = z.infer<
  typeof readChatAttachmentMissingSchema
>;

export const readChatAttachmentResponseSchema = z.discriminatedUnion("ok", [
  readChatAttachmentFoundSchema,
  readChatAttachmentMissingSchema,
]);
export type ReadChatAttachmentResponse = z.infer<
  typeof readChatAttachmentResponseSchema
>;
