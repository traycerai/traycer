import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isValidUpdateDispatchAckNonce,
  isValidUpdateDispatchAckReason,
  updateDispatchAckPath,
  UPDATE_DISPATCH_ACK_VERSION,
  type UpdateDispatchAck,
  type UpdateDispatchAckResult,
} from "@traycer/protocol/config/host-update-ack";
import type { HostUpdateAttemptIdentity } from "@traycer-clients/shared/host-update";

// Ticket 07 §5.2.8 — the child half of the dispatch ACK.
//
// The host resolver answers `host.update.install` at SPAWN, before this child
// has claimed anything. It cannot name the attempt without hearing from the
// child, so it mints a nonce, passes it on argv, and waits. This writes the
// answer.
//
// ## ORDERING IS THE CONTRACT
//
// The ACK must be stamped only AFTER the claim is durable. An ACK written
// first would attest an attempt that a crash one instant later un-makes,
// leaving the resolver reporting `accepted` for an attempt that never existed
// — a fabricated identity, which is the precise failure the arm was introduced
// to remove.
//
// This is wired as the executor segment's `acknowledge` callback, which the
// executor invokes immediately after the claim commits and describes in its
// own comment as "the private positive acknowledgement boundary". Using the
// existing seam rather than a new call site is what makes the ordering
// structural instead of a convention someone has to remember.
//
// ## Why the nonce may travel on argv
//
// It is a correlation value, not an authority. It grants nothing: a caller
// holding it cannot claim, mutate, or read anything, and the resolver accepts
// an ACK only if the nonce matches one IT minted for a child IT spawned. That
// is categorically different from a token, which must never be an argument.

/**
 * The decision this run is attesting: exactly one of "here is the attempt I
 * claimed" and "there is no attempt, and here is why".
 *
 * The `no-attempt` arm's only producer is `host update`'s selector — a no-op,
 * a recovery that owed nothing further, a refused bound intent, or a throw
 * that happened before any claim.
 */
export type UpdateDispatchAckDecision =
  | {
      readonly kind: "claimed";
      readonly identity: HostUpdateAttemptIdentity;
      readonly claimedAtIso: string;
    }
  | { readonly kind: "no-attempt"; readonly reason: string };

/** Written atomically, so a reader never sees a partial ACK. */
export async function stampUpdateDispatchAck(input: {
  readonly hostHomeDir: string;
  readonly nonce: string;
  readonly decision: UpdateDispatchAckDecision;
}): Promise<void> {
  if (!isValidUpdateDispatchAckNonce(input.nonce)) {
    // Refused rather than written. A nonce this build considers illegal cannot
    // be one the resolver minted, so writing it could only ever produce a file
    // that no wait will accept — and a junk file on the host home is worse
    // than none.
    throw new Error("update dispatch ack nonce is not a legal nonce");
  }
  const ack: UpdateDispatchAck = {
    v: UPDATE_DISPATCH_ACK_VERSION,
    nonce: input.nonce,
    result: resultFor(input.decision),
  };
  const target = updateDispatchAckPath(input.hostHomeDir);
  // Agent-scoped temp name: pid AND a monotonic-ish suffix, so two children of
  // the same host home cannot collide on the scratch file even within one
  // millisecond of each other.
  const temp = join(
    input.hostHomeDir,
    `.update-dispatch-ack.${process.pid}.${Date.now()}.${Math.floor(
      Math.random() * 1e6,
    )}.tmp`,
  );
  try {
    await writeFile(temp, `${JSON.stringify(ack)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // `rename` is the publish. Atomic within a filesystem, so the reader sees
    // either the previous dispatch's ACK or this one, never a half-written mix
    // of the two.
    await rename(temp, target);
  } catch (error) {
    // Never leak the scratch file. A failed stamp is recoverable — the
    // resolver times out and reports indeterminate, which is true — but a
    // leaked temp accumulates silently in the host home forever.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function resultFor(
  decision: UpdateDispatchAckDecision,
): UpdateDispatchAckResult {
  if (decision.kind === "claimed") {
    // The v2 `claimed` arm — the same facts v1 carried at the top level.
    return {
      kind: "claimed",
      attemptId: decision.identity.attemptId,
      generation: decision.identity.generation,
      sequence: decision.identity.sequence,
      claimedAt: decision.claimedAtIso,
    };
  }
  if (!isValidUpdateDispatchAckReason(decision.reason)) {
    // Refused for the same reason an illegal nonce is: the reason crosses a
    // repository boundary, and the host re-checks it against this exact
    // grammar before it reaches a log line or an RPC response. A value this
    // contract cannot produce must not be written in the first place.
    throw new Error("update dispatch ack reason is not a legal reason");
  }
  return { kind: "no-attempt", reason: decision.reason };
}

/**
 * The executor acknowledgement callback for a dispatched run, or `null` when
 * this run carries no nonce.
 *
 * Installed by `host update` when the dispatching resolver passed
 * `--ack-nonce`. It IS the executor segment's `acknowledge` hook — the seam the
 * executor invokes immediately after the claim commits, and describes as "the
 * private positive acknowledgement boundary". Handing it the stamper is what
 * puts the write on the right side of the claim without a new call site.
 *
 * `noAttempt` is the other half of the same contract, and the reason it is on
 * the SAME object: a run stamps exactly one of the two, and a caller that has
 * to reach for a second factory to report "no attempt" is a caller that can
 * forget to. Every exit `host update` has - a claim, a release, a rejection,
 * and a throw that happened before any claim - goes through one of these.
 */
export type DispatchAckAcknowledgement = (claim: {
  readonly identity: HostUpdateAttemptIdentity;
}) => Promise<void>;

export interface DispatchAckStamper {
  /**
   * The executor segment's `acknowledge` hook - the seam the executor invokes
   * immediately after the claim commits, and describes as "the private
   * positive acknowledgement boundary". Handing it the stamper is what puts
   * the write on the right side of the claim without a new call site.
   */
  readonly acknowledge: DispatchAckAcknowledgement;
  /** No attempt was claimed, and here is why (the ACK's reason grammar). */
  readonly noAttempt: (reason: string) => Promise<void>;
}

/**
 * Validate the nonce and build the stamper, or `null` when this run carries no
 * nonce.
 *
 * **Throws on an illegal nonce, and callers must invoke this BEFORE anything
 * is written.** A dispatched run that carries a nonce this build cannot honour
 * has already lost the correlation the caller is waiting on; discovering that
 * after staging bytes would mean doing destructive work for a dispatch that
 * can only ever report indeterminate.
 */
export function installDispatchAckStamper(
  hostHomeDir: string,
  nonce: string | null,
): DispatchAckStamper | null {
  if (nonce === null) return null;
  if (!isValidUpdateDispatchAckNonce(nonce)) {
    throw new Error("update dispatch ack nonce is not a legal nonce");
  }
  // ONCE-ONLY, and the flag lives HERE rather than in the caller because this
  // is the single writer: a run has exactly one answer for the dispatcher, and
  // the FIRST one it reaches is the true one. Several exits legitimately pass
  // through two of them - a rejected segment reports the claim refusal and
  // then throws `E_HOST_UPDATE_ATTEMPT_ACTIVE`; a release whose projection
  // cannot read the install record reports the release and then throws
  // `E_HOST_NOT_INSTALLED` - and in both the SECOND value is a consequence of
  // the first, not a better description of it. Letting the second win would
  // replace "the cohort refused this claim" with "something was already
  // active", which is not what happened.
  //
  // Idempotent rather than guarded at the call sites: a caller that must
  // remember not to stamp twice is a caller that will.
  let settled = false;
  return {
    acknowledge: async (claim) => {
      if (settled) return;
      settled = true;
      await stampUpdateDispatchAck({
        hostHomeDir,
        nonce,
        decision: {
          kind: "claimed",
          identity: claim.identity,
          claimedAtIso: new Date().toISOString(),
        },
      });
    },
    noAttempt: async (reason) => {
      if (settled) return;
      settled = true;
      await stampUpdateDispatchAck({
        hostHomeDir,
        nonce,
        decision: { kind: "no-attempt", reason },
      });
    },
  };
}
