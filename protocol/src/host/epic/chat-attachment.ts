import { z } from "zod";

import { assetMediaTypeSchema } from "@traycer/protocol/host/asset-stream-schemas";

/**
 * Host <-> client wire shape for reading ONE chat image attachment's bytes.
 *
 * ## Why this exists at all
 *
 * Chat image bytes used to live in the epic Y.Doc's content-addressed
 * `attachments` map, which every epic participant's host replicates whole. That
 * is the wrong home for two reasons that are not fixable in place: a Yjs
 * document replicates all-or-nothing, so a PRIVATE chat's pasted image is
 * readable by anyone with epic access; and the referencing messages themselves
 * left the doc for the per-host chat store, so the bytes and their referencer
 * no longer share a reachability set.
 *
 * The bytes now follow their referencer onto the chat plane - a per-epic disk
 * store on the owning host, published as `image-attachment` chat blobs - and
 * this method is how a viewer gets them back. The viewer's TAB host resolves it:
 * its own local disk store first (the owning-host case, and the live cross-host
 * case), else a bearer pass-through to the cloud blob the owning host published,
 * where the server applies the same per-chat ACL it applies to every other chat
 * read.
 *
 * ## `chatId` is REQUIRED, and it is the whole privacy argument
 *
 * A hash is a content address, not a capability. If this method took `(epicId,
 * hash)` the host would have no way to decide whether THIS caller may see THESE
 * bytes, and answering from the local disk store would hand any epic participant
 * the contents of any private chat that happens to live on that host - the exact
 * doc-map hole this move exists to close, rebuilt behind an RPC.
 *
 * With the chat id in hand the host gates the LOCAL read the same way it gates
 * live viewing of the same chat (owner, or a cloud-confirmed `task`-visible chat
 * read with the subscriber's own bearer), and the cloud leg is gated server-side
 * by the identity it is already fetching under. The client always knows the
 * owning chat - every render site reaches this from a message inside one - so
 * requiring it costs nothing and is not a field a caller can meaningfully forge:
 * a wrong chat id fails the gate rather than widening it.
 *
 * ## Optional capability
 *
 * Registered `degrade: { kind: "unsupported" }` and NOT on the released floor -
 * a new method NAME is handshake-fatal against a released peer. A host that
 * predates this surface answers `E_HOST_UNSUPPORTED`, and the client's contract
 * is to fall back to the epic doc-replica read it used before this method
 * existed, which is exactly that host's own behavior today. There is no
 * user-visible degradation to render, so nothing renders one.
 *
 * ## Transport: unary base64, not the asset stream
 *
 * Chat images are capped at 5 MiB at paste time, and whole-body mux chunking
 * removed the 1 MiB remote-frame ceiling that motivated the asset stream for
 * 20 MiB workspace files. Unary keeps the client's resolution chain one shape
 * (cache -> this -> doc replica) instead of splicing a four-frame stream into
 * the middle of it. Precedent and rationale for the base64 field itself:
 * `epic.readCloudChatPayload` in `cloud-chat.ts` - a byte channel that a JS
 * string round trip would silently corrupt.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const readChatAttachmentRequestSchema = z.object({
  epicId: z.string().min(1),
  /**
   * The chat that REFERENCES the attachment - the authorization subject, not a
   * lookup key. See the visibility argument above: without it the host cannot
   * gate a local-store hit, and a content address alone would leak private-chat
   * bytes to any epic participant.
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
   * HOST-AUTHORITATIVE, derived from the delivered bytes' magic bytes - never
   * echoed from a client-declared media type and never inferred from a file
   * extension. Same rule and same enum as the asset-stream header
   * (`assetMediaTypeSchema`), reused rather than re-declared so the set of
   * formats a renderer must handle cannot drift between the two byte channels.
   */
  mediaType: assetMediaTypeSchema,
});
export type ReadChatAttachmentFound = z.infer<
  typeof readChatAttachmentFoundSchema
>;

/**
 * The bytes are not obtainable, and this is DATA rather than a throw.
 *
 * One reason arm, deliberately. "Not on this host's disk", "never published",
 * "published but this viewer may not read that chat" and "this chat does not
 * exist" all collapse to `missing`, mirroring the posture the server already
 * takes on every chat read (`requireReadableChat`: a chat you may not see is
 * NOT FOUND, never forbidden). Distinguishing a refusal from an absence would
 * turn this into an existence oracle over other people's private chats -
 * answerable by anyone who can guess a `(chatId, hash)` pair - which is the
 * same leak the `chatId` requirement above exists to prevent, just moved into
 * the response.
 *
 * TRANSIENT failures are NOT this. A dropped socket, a cloud 5xx, an unreadable
 * disk - those ride the RPC error channel and throw, so the client's blob cache
 * retries them instead of caching a permanent "unavailable" for bytes that are
 * one good request away. `missing` is the answer a client should render the
 * "stored on the originating device" marker for.
 */
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
