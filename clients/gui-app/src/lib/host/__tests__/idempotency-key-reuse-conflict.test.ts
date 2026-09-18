import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT,
  RPC_ERROR_CODES,
  type RpcErrorCode,
} from "@traycer/protocol/framework/index";
import { isIdempotencyKeyReuseConflict } from "@/lib/host/idempotency-key-reuse-conflict";

/**
 * `HostRpcError`'s own constructor type, not a widened stand-in.
 *
 * `RpcErrorCode` rather than `string` because that is what the error carries
 * (`rpc-types.ts`): by the time one of these reaches the predicate, the
 * transport has ALREADY narrowed an unrecognised wire code to `RPC_ERROR` at
 * the four `isRpcErrorCode` sites. So "a host sent a code this client does not
 * know" is not representable here and must not be faked by loosening the
 * fixture - it is the pre-code-host case, and it is covered by the
 * `code: "RPC_ERROR"` cases below, which is exactly the value such a host's
 * code arrives as.
 */
function hostError(input: {
  readonly code: RpcErrorCode;
  readonly message: string;
}): HostRpcError {
  return new HostRpcError({
    code: input.code,
    message: input.message,
    requestId: "req-1",
    method: "epic.create",
    fatalDetails: null,
  });
}

/** The sentence a current host builds, from the shared fragment. */
const CURRENT_HOST_MESSAGE =
  "The idempotency key was already used for a different RPC contract.";

describe("isIdempotencyKeyReuseConflict", () => {
  it("matches on the code alone, with a message that carries no fragment", () => {
    // The point of minting the code: recognition stops depending on English.
    // A host that reworded its sentence entirely is still recognised.
    expect(
      isIdempotencyKeyReuseConflict(
        hostError({
          code: "IDEMPOTENCY_KEY_REUSE",
          message: "That request was already handled under a different shape.",
        }),
      ),
    ).toBe(true);
  });

  it("matches a pre-code host on the fragment alone", () => {
    // Such a host sends the generic code every other refusal also uses, so the
    // prose is genuinely the only discriminator available against it.
    expect(
      isIdempotencyKeyReuseConflict(
        hostError({ code: "RPC_ERROR", message: CURRENT_HOST_MESSAGE }),
      ),
    ).toBe(true);
  });

  it("matches case-insensitively and by substring, so a wrapped message lands", () => {
    expect(
      isIdempotencyKeyReuseConflict(
        hostError({
          code: "RPC_ERROR",
          message: `Host refused: THE IDEMPOTENCY KEY WAS ALREADY USED here.`,
        }),
      ),
    ).toBe(true);
  });

  it("rejects an unrelated refusal - the negative control", () => {
    expect(
      isIdempotencyKeyReuseConflict(
        hostError({ code: "RPC_ERROR", message: "Could not create the epic." }),
      ),
    ).toBe(false);
  });

  it("rejects another typed refusal that is not this one", () => {
    expect(
      isIdempotencyKeyReuseConflict(
        hostError({ code: "WORKTREE_BUSY", message: "Worktree is busy." }),
      ),
    ).toBe(false);
  });
});

describe("the two halves are one definition", () => {
  it("IDEMPOTENCY_KEY_REUSE is an RPC_ERROR_CODES member, so it survives isRpcErrorCode narrowing", () => {
    // If it were not a member, every client would narrow it to RPC_ERROR
    // before this predicate ever saw it, and the code half would be dead.
    expect(RPC_ERROR_CODES).toContain("IDEMPOTENCY_KEY_REUSE");
  });

  it("the fragment constant is what the predicate matches, lower-cased at its definition", () => {
    expect(IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT).toBe(
      IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT.toLowerCase(),
    );
    // Built from the constant rather than a literal typed out here: this is the
    // assertion that fails if the host and the renderer ever stop sharing one
    // definition of the sentence.
    expect(
      isIdempotencyKeyReuseConflict(
        hostError({
          code: "RPC_ERROR",
          message: `Refused. The ${IDEMPOTENCY_KEY_REUSE_MESSAGE_FRAGMENT} already.`,
        }),
      ),
    ).toBe(true);
  });
});
