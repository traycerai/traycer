import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT } from "@traycer/protocol/framework/ws-protocol";

/**
 * The host's idempotency cache refusing a key it has already seen under a
 * different contract or different params - its `keyReuseConflict`, which it
 * answers with HTTP status 409.
 *
 * TWO TESTS, IN PRIORITY ORDER, and the order is the whole design.
 *
 * 1. `code === "IDEMPOTENCY_KEY_REUSE"`. The host mints this code for exactly
 *    this outcome. It is an `RPC_ERROR_CODES` member, so it survives the
 *    client's `isRpcErrorCode` narrowing intact, and it is a fact about the
 *    wire rather than about English.
 * 2. The message fragment, for hosts that PREDATE the code. Such a host sends
 *    the generic `RPC_ERROR` that every other refusal also uses, so the prose
 *    is genuinely the only discriminator available against it. The fragment is
 *    `IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT`, imported from the protocol
 *    package - the SAME constant the host builds its sentence from, so the two
 *    halves can no longer drift. It used to be a literal written out here and
 *    again in the host, each with a docblock pointing at the other.
 *
 * The fallback cannot be deleted until no pre-code host is in the field. When
 * that day comes, delete the second test and the constant together.
 *
 * WHY NOT `status === 409`: the WS response frame carries only the body.
 * `DispatchOutcome.status` is consumed host-side for routing and never enters
 * the response envelope, and `HostRpcError` has no field to receive one - it
 * carries `code`, `requestId`, `method`, `fatalDetails` and the worktree-holder
 * fields. So conjoining this predicate with a status is not available to it.
 *
 * FAILING TO RECOGNISE IT IS SAFE, which is what makes the fallback half
 * acceptable: the only consequence is that a create whose key was reused falls
 * through to today's "couldn't create" toast instead of asking the host whether
 * the epic exists first. Nothing is written, retried or discarded on the
 * strength of this predicate - it only decides whether to LOOK before speaking.
 */
export function isIdempotencyKeyReuseConflict(error: HostRpcError): boolean {
  if (error.code === "IDEMPOTENCY_KEY_REUSE") return true;
  return error.message
    .toLowerCase()
    .includes(IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT);
}
