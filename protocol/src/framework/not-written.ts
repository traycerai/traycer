/**
 * `notWritten: true` on an RPC error: the host refused this attempt before
 * its row. No row of the attempt exists, and it will write none. A
 * conversation's chat it created, or images it stored for a row never
 * written, are not its row. It speaks for this attempt only. After an
 * earlier attempt of the same request whose outcome is unknown, it does not
 * say that the earlier one has no row. So once one attempt of a send is
 * unknown, a later refusal marked `notWritten` gives no text back: the send
 * stays unconfirmed, with Retry.
 *
 * A host that serves `bot.conversation.send@1.7` sets it on a failure of a
 * send that carries a nonce when it knows the attempt has no row, whatever
 * the code: one raised before the send reached its write, or one under the
 * request's lock when the store, read again under that lock, holds no row of
 * the request. It sets it too on an `E_BOT_SEND_CONFLICT` its lookup found
 * before accepting a send of any version that names its request. A failure
 * after the row, one whose re-read fails, and a conflict the row's own write
 * found are never marked. A host below 1.7 never sets it, so each of its
 * errors leaves the outcome unknown.
 */
import { z } from "zod";
import { lazySchema } from "./lazy-schema";

/**
 * The envelope field. Optional so every `{ code, message }` that parsed before
 * still parses, and a malformed value sanitizes to absent rather than
 * rejecting the envelope, as `holders` and `staleWrite` do.
 */
export const notWrittenWireFieldSchema = lazySchema(() =>
  z.literal(true).optional().catch(undefined),
);
