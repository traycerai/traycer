/**
 * `notWritten: true` on an RPC error: the host refused this attempt before it
 * wrote anything. It speaks for this attempt only. After an earlier attempt
 * of the same request whose outcome is unknown, it does not say that the
 * earlier one wrote nothing. `bot.conversation.send@1.7` sets it (T249); an
 * older host never does, so each of its errors leaves the outcome unknown.
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
