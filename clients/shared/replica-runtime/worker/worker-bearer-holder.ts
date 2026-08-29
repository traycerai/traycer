/**
 * The worker's replica of the bearer.
 *
 * `WsStreamClient` reads its bearer through a SYNCHRONOUS
 * `BearerSourceProvider`, deep inside a dial and again on every reconnect and
 * every rotation push. That read cannot become a round trip to the main
 * thread: it happens on a path with no `await` to give, and a dial that waited
 * on the main thread would re-create exactly the stall the worker exists to
 * escape. So the token is PUSHED into the worker and held here, and the
 * transport's read stays synchronous against a local value.
 *
 * What crosses is only ever the token and its user. No credential lease, no
 * request context, no refresh machinery: revalidation stays on the main
 * thread, which is where the auth service, the single-flight refresh and the
 * sign-out path already live, and the worker learns the outcome as one more
 * push.
 *
 * Fail-closed is the whole posture. Before the first push, and after a
 * sign-out push, the provider answers `null`, which
 * `extractBearerForOpenFrame` turns into a pre-dial failure - the transport
 * never sends `open { token: "" }`, and never dials with a token it was not
 * given. That is the same contract the CLI's `MutableBearerLease` honours, and
 * this holder is built on it rather than beside it.
 */
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type {
  BearerLease,
  BearerSourceProvider,
} from "@traycer-clients/shared/auth/bearer-source";
import type { BearerProbe, BearerPush } from "./bridge-protocol";

export interface WorkerBearerHolder {
  /**
   * The provider every stream/RPC client in the worker is constructed with.
   *
   * Stable for the holder's lifetime, so a client built before the first push
   * is still built correctly - it simply cannot dial until one arrives.
   */
  readonly source: BearerSourceProvider;
  /** Applies a push from the main thread. Idempotent for an identical push. */
  apply(push: BearerPush): void;
  /** What this holder would answer a dial right now. Never the token itself. */
  probe(): BearerProbe;
}

export function createWorkerBearerHolder(): WorkerBearerHolder {
  // One variable, not a lease plus a shadow copy of its user: the identity is
  // already on the lease, and a second field holding it is a second thing to
  // keep in step across sign-out.
  let lease: BearerLease | null = null;

  return {
    source: () => lease,
    apply(push): void {
      if (push.state === "absent") {
        // Drop the lease outright rather than rotating it to `""`. An empty
        // lease still answers an identity, and the transport's own same-user
        // rotation guard would then read a signed-out holder as "the same
        // user, no token yet" instead of "nobody is signed in".
        lease = null;
        return;
      }
      if (lease !== null && lease.identity.userId === push.userId) {
        // Rotate in place for the same user, mirroring the renderer's
        // `CredentialLease.rotateBearerToken`. The transport re-reads the
        // provider on every dial, so a replacement would also be observed -
        // but an in-place rotation keeps the holder's identity stable across a
        // refresh, which is what the same-user rotation guard downstream
        // compares against.
        lease.rotate(push.token);
        return;
      }
      lease = new MutableBearerLease(push.token, push.userId);
    },
    probe(): BearerProbe {
      return lease === null
        ? { state: "absent" }
        : { state: "present", userId: lease.identity.userId };
    },
  };
}
