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
   * refresh family is dead; the distinction is kept for logging, since neither
   * case involves the user.
   */
  readonly reason: Exclude<HostCredentialState, "active">;
}

/**
 * The result of one provisioning attempt.
 *
 * `unavailable` deliberately merges every "nothing to hand over" case - the 409
 * supersede (another client won the race and its credential is already on its
 * way), a rejected hostId, an expired sign-in, a network failure. None of them
 * produce a credential, and in all of them the host simply stays on the
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
  | { readonly kind: "unavailable" }
  /**
   * Nothing to hand over, and this caller should not treat its attempt as
   * spent - either because another transport's credential for this host is
   * already on its way (the adoption claim), or because the app-wide mint
   * escalation ladder is deferring re-mints for a host that has been minting
   * too often to be healthy. In the second case there is no delivery in
   * flight. In both cases the transport gives its attempt marker back AND
   * arms a timer for `retryAfterMs`, so the retry does not depend on another
   * `openAck` arriving - which matters because the host's state does not
   * change while the window runs, so there is no edge left to wake anyone.
   *
   * Split out of `unavailable` for one reason: `unavailable` is terminal for
   * the asking client (it has had its one attempt), and that is right for
   * every case it covers - a rejected hostId, an expired sign-in, a mint that
   * failed. It is wrong here, because nothing was attempted and nothing
   * failed; the app is waiting, on a claim or on a backoff window. A
   * transport that burned its single attempt on this answer, and then turned
   * out to be the only surviving one, would leave the host on the client lease
   * with nobody left to ask - the app-wide claim protecting the credential
   * would have stranded the host instead.
   */
  | {
      readonly kind: "pending-elsewhere";
      /**
       * How long to wait before asking again, in milliseconds.
       *
       * Carried on the OUTCOME rather than shared as a constant because the
       * two things that answer `pending-elsewhere` have genuinely different
       * waits - the remaining adoption-claim TTL, and the remaining rung of
       * the mint escalation ladder - and only the flow knows which applies or
       * how much of it is left. A constant here would have to be the longer of
       * the two for safety, which would idle a host through a claim that
       * expired seconds after it asked.
       *
       * The transport arms a timer for this and re-asks WITHOUT needing a new
       * `openAck`, because in both cases the host's state does not change
       * while the window runs: it keeps reporting `needs-reauth`, so there is
       * no edge left to wake anybody.
       */
      readonly retryAfterMs: number;
    };

/**
 * App-supplied hook that mints a host credential and hands it back for delivery.
 *
 * Provisioning is **silent**: the mint needs only the caller's ordinary bearer,
 * so there is no dialog, no OTP, and no headless special case. A delegated host
 * credential is a refresh family like any other - what bounds it is that the
 * owner sees the row in Devices & Sessions and can revoke it, exactly as for an
 * interactive session. (This reverses an earlier design that gated the mint on
 * step-up; see the mint route's doc comment for why that gate did not pay for
 * itself.)
 *
 * One obligation survives that change, for a different reason than before. The
 * implementor must be **single-flight per hostId across the whole app**, because
 * a surface routinely holds several `WsStreamClient`s against one host (a
 * durable transport plus one-shot ones) and each is a separate instance with its
 * own state. That used to be about not stacking OTP dialogs; now it is about
 * correctness: the server supersedes older credentials for a host on every mint,
 * so concurrent mints would revoke each other's rows and settle as 409s, leaving
 * the host tokenless after a burst of work.
 */
export type HostCredentialMintFlow = (
  request: HostCredentialMintRequest,
) => Promise<HostCredentialMintOutcome>;
