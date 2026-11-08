import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The `attrs` of a `fileAttachment` node: an inline atom in message
 * `JsonContent` that names one non-image file the author attached.
 *
 * Always BY HASH. Unlike `imageAttachment` there is no inline base64 form: the
 * bytes live in the host's attachment store under `hash`, and `hash` is what
 * the reachability walk, the chat-blob publisher and fork carriage key on. A
 * node that carried a path or the bytes instead would be invisible to all
 * three.
 *
 * `JsonContent` leaves `type` an open string (`common/registry.ts`), so this
 * node needs no record version: a reader that predates it sees an unknown node
 * and draws nothing for it, with the surrounding text intact.
 *
 * `mediaType` and `fileName` are what the author's client DECLARED, never
 * sniffed, and nothing executes the bytes. A download (`epic.readChatFile`)
 * returns the bytes alone, so these attrs are the one source of a file's name
 * and type. Unknown keys strip, so a composer
 * may carry its own transient attrs (an upload state) on the same node.
 */
export const fileAttachmentAttrsSchema = lazySchema(() =>
  z.object({
    /** The node's own identity in the document, not a content address. */
    id: z.string().min(1),
    /** Lowercase hex sha256 of the raw file bytes. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
    /** Decoded byte length of the file. */
    size: z.number().int().nonnegative(),
  }),
);
export type FileAttachmentAttrs = z.infer<typeof fileAttachmentAttrsSchema>;

/**
 * The most file attachments one message may carry, counted one per distinct
 * `(hash, fileName)` - one per line of the agent's "Attached files" block.
 * Image attachments are not counted.
 *
 * The host refuses a send, and pauses a queued message, that is over it, with
 * {@link TOO_MANY_ATTACHMENTS_CODE}. A client stops at it first so the person
 * learns at attach time rather than at send.
 */
export const MAX_FILE_ATTACHMENTS_PER_MESSAGE = 20;

/**
 * The refusal code for a message over {@link MAX_FILE_ATTACHMENTS_PER_MESSAGE}:
 * a send's rejected acknowledgement, and the notice a paused queued message
 * carries.
 */
export const TOO_MANY_ATTACHMENTS_CODE = "TOO_MANY_ATTACHMENTS";
