/**
 * `notWritten: true` on an RPC error: the host refused this attempt before it
 * wrote anything. It speaks for this attempt only. After an earlier attempt
 * of the same request whose outcome is unknown, it does not say that the
 * earlier one wrote nothing. So once one attempt of a send is unknown, a
 * later refusal marked `notWritten` gives no text back: the send stays
 * unconfirmed, with Retry.
 *
 * A host from T249 on sets it on the refusals it raises before the write:
 * those of a `bot.conversation.send@1.7`, and an `E_BOT_SEND_CONFLICT` its
 * lookup found before accepting a send of any version that names its
 * request. A refusal from the write's own guard is never marked. A host that
 * predates T249 never sets it, so each of its errors leaves the outcome
 * unknown.
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
