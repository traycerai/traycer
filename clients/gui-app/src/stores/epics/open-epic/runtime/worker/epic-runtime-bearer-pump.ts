/**
 * Keeps the worker's bearer replica current.
 *
 * The worker cannot pull a bearer - `getBearerToken()` is read synchronously
 * inside a dial - so the main thread pushes, and this is the thing that
 * decides when.
 *
 * It subscribes to BOTH host-client signals, and that is the correctness point
 * of the module rather than a detail. `onBearerRotated` fires only for an
 * in-place, SAME-USER token refresh; identity transitions - sign-in, sign-out,
 * switching user - keep the token they already had and fire `onChange`
 * instead. A pump wired to the rotation signal alone (which is the seam the
 * relocation was scoped around) would therefore never learn that the user
 * signed out, and would leave the worker re-dialing forever with a credential
 * for somebody who is no longer here. Two signals, one read.
 *
 * The read itself is fail-closed: anything other than a usable token becomes
 * `absent`, which makes the worker's provider answer `null` and the transport
 * fail before dialing rather than send `open { token: "" }`.
 */
import type {
  HostClientChangeEvent,
  HostClientUnsubscribe,
} from "@traycer-clients/shared/host-client/host-client";
import {
  CredentialLeaseReleasedError,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import type { BearerPush } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";

/**
 * The slice of `HostClient` this pump needs.
 *
 * Structural rather than the class, so a suite can drive the real pump with
 * three functions instead of standing up a host client - the pump's whole
 * behaviour is which signals it listens to and what it makes of them.
 */
export interface BearerPumpHostClient {
  getRequestContext(): RequestContext | null;
  onChange(
    handler: (event: HostClientChangeEvent) => void,
  ): HostClientUnsubscribe;
  onBearerRotated(handler: () => void): HostClientUnsubscribe;
}

export interface BearerPumpOptions {
  readonly hostClient: BearerPumpHostClient;
  /** Where a push goes. The bridge in production. */
  readonly push: (bearer: BearerPush) => void;
  /**
   * Reports a read that failed for a reason other than "no credential".
   *
   * Not optional, and not swallowed: the pump runs inside the host client's
   * notification loop, which iterates its subscribers without catching, so a
   * throw here would silently stop every OTHER subscriber of that signal. The
   * pump therefore absorbs the throw, pushes `absent`, and hands the cause to
   * whoever owns logging.
   */
  readonly onReadFailure: (cause: unknown) => void;
}

/**
 * Pushes the current bearer immediately, then on every rotation and every
 * identity change. Returns the unsubscribe.
 */
export function startBearerPump(options: BearerPumpOptions): () => void {
  let lastPushed: BearerPush | null = null;

  const pushCurrent = (): void => {
    let next: BearerPush;
    try {
      next = readBearerPush(options.hostClient.getRequestContext());
    } catch (cause: unknown) {
      options.onReadFailure(cause);
      next = { state: "absent" };
    }
    // `onChange` fires for identity transitions that often leave the bearer
    // untouched, and a rotation can re-deliver a token the worker already
    // holds. Sending those anyway is not incorrect, only noisy - but the noise
    // is a `postMessage` per event on the path this whole change exists to
    // keep quiet.
    if (lastPushed !== null && samePush(lastPushed, next)) return;
    lastPushed = next;
    options.push(next);
  };

  // Subscribe FIRST, then take the snapshot.
  //
  // The other order loses a credential change that lands in the gap: a
  // sign-out (or a rotation) between the snapshot read and the subscription
  // emits to nobody, and with no later identity event the worker keeps
  // re-dialing with a token for a user who has gone. Snapshot-last cannot lose
  // anything the other way round - a change that fires during registration is
  // simply reflected in the snapshot that follows it.
  //
  // Safe against double-pushing because `lastPushed` is `null` until the first
  // push, so the dedupe below cannot suppress the snapshot even when a
  // subscription callback already pushed the identical value.
  const unsubscribeChange = options.hostClient.onChange(() => {
    pushCurrent();
  });
  const unsubscribeRotation = options.hostClient.onBearerRotated(() => {
    pushCurrent();
  });
  pushCurrent();

  return () => {
    unsubscribeChange();
    unsubscribeRotation();
  };
}

/**
 * Reduces a request context to what crosses the boundary.
 *
 * Exported because it is the fail-closed rule, and a rule with more than one
 * reading deserves its own pin: no context, a released lease, and an empty
 * token all mean the same thing to the transport, and all three reach it as
 * `absent`.
 */
export function readBearerPush(context: RequestContext | null): BearerPush {
  if (context === null) return { state: "absent" };
  let token: string;
  try {
    token = context.credentials.getBearerToken();
  } catch (cause: unknown) {
    // The documented throw of a released lease, and the ordinary way a
    // sign-out presents. Anything else is a real fault and stays a throw for
    // the pump to report - a fail-closed default that also hides bugs is worse
    // than the bug.
    if (cause instanceof CredentialLeaseReleasedError)
      return { state: "absent" };
    throw cause;
  }
  return token.length === 0
    ? { state: "absent" }
    : {
        state: "present",
        token,
        userId: context.credentials.identity.userId,
      };
}

function samePush(left: BearerPush, right: BearerPush): boolean {
  if (left.state === "absent" || right.state === "absent") {
    return left.state === right.state;
  }
  return left.token === right.token && left.userId === right.userId;
}
