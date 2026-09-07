import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";

export interface HostCredentialMintRequest {
  /** The host to mint for - the id of the endpoint this connection dialed. */
  readonly hostId: string;
  /** Why the host wants one. */
  readonly reason: Exclude<HostCredentialState, "active">;
}

/**
 * The result of one provisioning attempt.
 * `unavailable` deliberately merges every "nothing to hand over" case - the 409 supersede (another client won the race and its credential is already on its way), a rejected hostId, an expired sign-in, a network failure.
 */
export type HostCredentialMintOutcome =
  | {
      readonly kind: "provisioned";
      /** Host-audience access JWS. */
      readonly token: string;
      /** Single-use refresh JWE - opaque to both client and host. */
      readonly refreshToken: string;
      /** The server's adoption tuple, relayed verbatim onto the wire. */
      readonly familyId: string;
      readonly provisionedAt: string;
      /**
       * Lifetime of the access jws in seconds, as the server stated it.
       * Used to bound how long an undelivered credential may be held; taken from the response rather than decoded out of the token so an unreadable token cannot produce a credential that is held forever.
       */
      readonly expiresIn: number;
    }
  | { readonly kind: "unavailable" }
  /**
   * In the second case there is no delivery in flight.
   * It is wrong here, because nothing was attempted and nothing failed; the app is waiting, on a claim or on a backoff window.
   */
  | {
      readonly kind: "pending-elsewhere";
      /**
       * How long to wait before asking again, in milliseconds.
       * A constant here would have to be the longer of the two for safety, which would idle a host through a claim that expired seconds after it asked.
       */
      readonly retryAfterMs: number;
    };

    /**
     * App-supplied hook that mints a host credential and hands it back for delivery.
     * Provisioning is **silent**: the mint needs only the caller's ordinary bearer, so there is no dialog, no otp, and no headless special case.
     */
export type HostCredentialMintFlow = (
  request: HostCredentialMintRequest,
) => Promise<HostCredentialMintOutcome>;
