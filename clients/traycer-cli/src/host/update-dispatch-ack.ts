import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isValidUpdateDispatchAckNonce,
  updateDispatchAckPath,
  UPDATE_DISPATCH_ACK_VERSION,
  type UpdateDispatchAck,
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

/** Written atomically, so a reader never sees a partial ACK. */
export async function stampUpdateDispatchAck(input: {
  readonly hostHomeDir: string;
  readonly nonce: string;
  readonly identity: HostUpdateAttemptIdentity;
  readonly claimedAtIso: string;
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
    attemptId: input.identity.attemptId,
    generation: input.identity.generation,
    sequence: input.identity.sequence,
    claimedAt: input.claimedAtIso,
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
 * Pre-cutover the legacy `host update` path never reaches an executor claim
 * (its contender admission is `legacy-update-shadow`, disposition `yield`, and
 * it creates no schema-v2 attempt), so the callback is installed and not
 * invoked. That junction is the cutover, and it is the same one the resolver's
 * gated wait is waiting on.
 */
export type DispatchAckAcknowledgement = (claim: {
  readonly identity: HostUpdateAttemptIdentity;
}) => Promise<void>;

/**
 * Validate the nonce and build the acknowledgement.
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
): DispatchAckAcknowledgement | null {
  if (nonce === null) return null;
  if (!isValidUpdateDispatchAckNonce(nonce)) {
    throw new Error("update dispatch ack nonce is not a legal nonce");
  }
  return async (claim) => {
    await stampUpdateDispatchAck({
      hostHomeDir,
      nonce,
      identity: claim.identity,
      claimedAtIso: new Date().toISOString(),
    });
  };
}
