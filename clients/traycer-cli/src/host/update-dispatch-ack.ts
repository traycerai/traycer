import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isValidUpdateDispatchAckNonce,
  updateDispatchAckPath,
  UPDATE_DISPATCH_ACK_VERSION,
  type UpdateDispatchAck,
} from "@traycer/protocol/config/host-update-ack";
import type { HostUpdateAttemptIdentity } from "@traycer-clients/shared/host-update";

// Child half of the dispatch ACK. The parent must not proceed until this lands.

/** Written atomically, so a reader never sees a partial ACK. */
export async function stampUpdateDispatchAck(input: {
  readonly hostHomeDir: string;
  readonly nonce: string;
  readonly identity: HostUpdateAttemptIdentity;
  readonly claimedAtIso: string;
}): Promise<void> {
  if (!isValidUpdateDispatchAckNonce(input.nonce)) {
    // Refused rather than written.
    // A nonce this build considers illegal cannot be one the resolver minted, so writing it could only ever produce a file that no wait will accept - and a junk file on the host home is worse than none.
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
  // Agent-scoped temp name: pid AND a monotonic-ish suffix, so two children of the same host home cannot collide on the scratch file even within one millisecond of each other.
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
    // `rename` is the publish.
    // Atomic within a filesystem, so the reader sees either the previous dispatch's ACK or this one, never a half-written mix of the two.
    await rename(temp, target);
  } catch (error) {
    // Never leak the scratch file.
    // A failed stamp is recoverable - the resolver times out and reports indeterminate, which is true - but a leaked temp accumulates silently in the host home forever.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The executor acknowledgement callback for a dispatched run, or `null` when this run carries no nonce. Installed by `host update` when the dispatching resolver passed `--ack-nonce`. */
export type DispatchAckAcknowledgement = (claim: {
  readonly identity: HostUpdateAttemptIdentity;
}) => Promise<void>;

/** Validate the nonce and build the acknowledgement. **Throws on an illegal nonce, and callers must invoke this BEFORE anything is written.** A dispatched run that carries a nonce this build cannot honour has already lost the correlation the caller is waiting on; discovering that after staging bytes would mean doing destructive work for a dispatch that can only ever report indeterminate. */
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
