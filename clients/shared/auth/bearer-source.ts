/**
 * The narrow bearer seam the host transport depends on.
 *
 * The WS clients (`WsRpcClient`, `WsStreamClient`) only need a bearer token for
 * the `open` frame - the host derives identity from the token itself. They do
 * NOT need a full `RequestContext`. Narrowing the dependency to this interface
 * lets every client supply a bearer "similarly": the renderer passes its
 * `RequestContext.credentials` (a `CredentialLease`, which satisfies this shape
 * structurally), and the CLI passes a `MutableBearerLease` over the token it
 * read from `~/.traycer/cli/credentials` - without fabricating an
 * `AuthenticatedUser`.
 */
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";

/**
 * Read side of the bearer seam used by the transport open frame.
 *
 * `identity.userId` is consumed only for diagnostics (the empty-token error
 * message) and the same-user rotation guard; the transport never reads the rest
 * of an identity. `getBearerToken()` throws when no bearer is available (e.g. a
 * released credential lease), which the transport maps to a pre-dial failure.
 */
export interface OpenFrameBearerSource {
  getBearerToken(): string;
  readonly identity: { readonly userId: string };
}

/**
 * Injectable source for the active bearer, read by the transport per request /
 * reconnect. `null` means "no bearer available" - the transport fails before
 * dialing rather than sending an empty `open` frame.
 */
export type BearerSourceProvider = () => OpenFrameBearerSource | null;

/**
 * Mutable counterpart used by the refresh path: the active bearer can be rotated
 * in place (same user) so the next `open` frame reads the rotated value without
 * rebuilding the client. The renderer's `CredentialLease.rotateBearerToken(...)`
 * plays this role on its side; the CLI uses `MutableBearerLease`.
 */
export interface BearerLease extends OpenFrameBearerSource {
  rotate(token: string): void;
}

/**
 * Minimal `BearerLease` for clients that hold a plain bearer string (the CLI).
 * Holds the token and a fixed `userId`; `rotate` swaps the token in place so a
 * shared transport client reading `() => lease` picks up the refreshed value on
 * its next request / reconnect.
 *
 * Honors the `OpenFrameBearerSource` contract that `getBearerToken()` THROWS
 * when no bearer is available: an empty token represents "no bearer" and raises
 * `CredentialLeaseReleasedError`, the same signal the renderer's `CredentialLease`
 * raises and the transport's `extractBearerForOpenFrame` already catches. So a
 * lease that is rotated to an empty value fails closed (pre-dial) rather than
 * sending `open { token: "" }`.
 */
export class MutableBearerLease implements BearerLease {
  readonly identity: { readonly userId: string };
  private token: string;

  constructor(token: string, userId: string) {
    this.token = token;
    this.identity = { userId };
  }

  getBearerToken(): string {
    if (this.token.length === 0) {
      throw new CredentialLeaseReleasedError(
        `No bearer available for user '${this.identity.userId}'`,
      );
    }
    return this.token;
  }

  rotate(token: string): void {
    this.token = token;
  }
}
