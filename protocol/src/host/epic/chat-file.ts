import { z } from "zod";

import { FILE_ATTACHMENT_MAX_BASE64_LENGTH } from "@traycer/protocol/host/drafts/schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Host <-> client wire shape for reading ONE chat file attachment's bytes: the
 * download behind a `fileAttachment` chip (`common/file-attachment.ts`).
 *
 * ## Why not `epic.readChatAttachment`
 *
 * That method's media type is HOST-AUTHORITATIVE: the host sniffs the bytes and
 * answers only for a supported image, on the disk leg and the cloud leg alike,
 * and its response is the frozen image enum. A file is not an image, so serving
 * it there would mean a branch that skips that guarantee. A file is read here
 * and that method keeps refusing non-images. A new minor of it would have cost
 * the same as a new method: an older host answers unsupported either way.
 *
 * ## Bytes only
 *
 * The found arm names no type and no file name. A download starts from a chip,
 * and the chip already holds the node's `fileName` and `mediaType`, which are
 * the one source for both. The cloud copy of a file is its raw bytes under
 * their digest, so a cloud-leg answer could only have restated the node or
 * invented a value.
 *
 * ## Same request, same gate, same single reason
 *
 * Everything `chat-attachment.ts` argues about the request holds unchanged.
 * `chatId` is REQUIRED because a hash is a content address, not a capability:
 * it is the authorization subject that gates a local-disk hit the way live
 * viewing of that chat is gated, and without it any epic participant could read
 * any private chat's file on that host. `plane: "local-only"` asks for the disk
 * leg alone. Every way of not obtaining the bytes collapses to `missing`, so the
 * response is no existence oracle over other people's chats; transient failures
 * ride the RPC error channel instead.
 *
 * ## Optional capability
 *
 * Registered `degrade: { kind: "unsupported" }` and NOT on the released floor:
 * a new method name is handshake-fatal against a released peer. A host that
 * predates it has never stored a file attachment.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
const sha256HexSchema = lazySchema(() => z.string().regex(/^[0-9a-f]{64}$/));

export const readChatFileRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    /** The chat that REFERENCES the file - the authorization subject. */
    chatId: z.string().min(1),
    /** Content address of the file bytes. */
    hash: sha256HexSchema,
    plane: z.literal("local-only").optional(),
  }),
);
export type ReadChatFileRequest = z.infer<typeof readChatFileRequestSchema>;

export const readChatFileResponseSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      /** Base64 of the RAW file bytes - what `hash` is over. */
      bytesBase64: z.string().max(FILE_ATTACHMENT_MAX_BASE64_LENGTH),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.literal("missing"),
    }),
  ]),
);
export type ReadChatFileResponse = z.infer<typeof readChatFileResponseSchema>;
