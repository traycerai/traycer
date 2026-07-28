import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";

/**
 * What the transport tells the app when a host reports it has no usable device
 * credential of its own.
 */
export interface HostCredentialMintRequest {
  /** The host to mint for - the id of the endpoint THIS connection dialed. */
  readonly hostId: string;
  /**
   * Why the host wants one. `needs-reauth` means it held a credential whose
   * refresh family is dead, so the user may reasonably be told this is a
   * re-authorization rather than a first-time grant.
   */
  readonly reason: Exclude<HostCredentialState, "active">;
}

/**
 * The result of one provisioning attempt.
 *
 * `unavailable` deliberately merges every "nothing to hand over, and asking
 * again right now would not help" case - the 409 supersede (another client won
 * the race and its credential is already on its way), a rejected hostId, an
 * expired sign-in, a network failure. None of them produce a credential and none
 * are worth a second interactive prompt; the host simply stays on the
 * connection's client lease, which is the designed fallback.
 */
export type HostCredentialMintOutcome =
  | {
      readonly kind: "provisioned";
      /** Host-audience access JWS. */
      readonly token: string;
      /** Single-use refresh JWE - opaque to both client and host. */
      readonly refreshToken: string;
      /**
       * The server's adoption tuple, relayed verbatim onto the wire. Neither
       * half is recoverable from the token - the access JWS carries no
       * `familyId`, and its `iat` is a different order at a coarser resolution -
       * so dropping them here would leave the host unable to decide between two
       * credentials at all. See the provision frame's doc comment.
       */
      readonly familyId: string;
      readonly provisionedAt: string;
      /**
       * Lifetime of the access JWS in seconds, as the SERVER stated it. Used to
       * bound how long an undelivered credential may be held; taken from the
       * response rather than decoded out of the token so an unreadable token
       * cannot produce a credential that is held forever.
       */
      readonly expiresIn: number;
    }
  | { readonly kind: "declined" }
  | { readonly kind: "unavailable" };

/**
 * App-supplied hook that mints a host credential and hands it back for delivery.
 *
 * The mint is **step-up gated server-side and therefore interactive**: desktop
 * raises its email-OTP dialog, the CLI prompts on the terminal. That has two
 * consequences the implementor owns, because the transport cannot:
 *
 *  1. **Be single-flight per hostId across the whole app.** A surface routinely
 *     holds several `WsStreamClient`s against one host (a durable transport plus
 *     one-shot ones), and each is a separate instance with its own state. The
 *     transport de-duplicates only within itself, so without an app-level guard
 *     one host reconnecting raises several OTP challenges at once.
 *  2. **Never prompt where nobody can answer.** A headless surface (the CLI's
 *     background `monitor`, CI) must return `declined` rather than block on a
 *     prompt no human will ever see.
 *
 * Returning `declined` is a first-class outcome, not a failure: the host keeps
 * working on the connection's client lease exactly as it did before this
 * capability existed.
 */
export type HostCredentialMintFlow = (
  request: HostCredentialMintRequest,
) => Promise<HostCredentialMintOutcome>;
