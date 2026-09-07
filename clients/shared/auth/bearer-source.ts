/**
 * The narrow bearer seam the host transport depends on.
 * The WS clients (`WsRpcClient`, `WsStreamClient`) only need a bearer token for the `open` frame - the host derives identity from the token itself.
 */
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";

/**
 * Read side of the bearer seam used by the transport open frame.
 * `identity.userId` is consumed only for diagnostics (the empty-token error message) and the same-user rotation guard; the transport never reads the rest of an identity.
 */
export interface OpenFrameBearerSource {
  getBearerToken(): string;
  readonly identity: { readonly userId: string };
}

/**
 * Injectable source for the active bearer, read by the transport per request / reconnect.
 * `null` means "no bearer available" - the transport fails before dialing rather than sending an empty `open` frame.
 */
export type BearerSourceProvider = () => OpenFrameBearerSource | null;

/**
 * Mutable counterpart used by the refresh path: the active bearer can be rotated in place (same user) so the next `open` frame reads the rotated value without rebuilding the client.
 */
export interface BearerLease extends OpenFrameBearerSource {
  rotate(token: string): void;
}

/**
 * Minimal `BearerLease` for clients that hold a plain bearer string (the CLI).
 * So a lease that is rotated to an empty value fails closed (pre-dial) rather than sending `open { token: "" }`.
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

/**
 * Reads a lease's current bearer, mapping the "no bearer" throw (`CredentialLeaseReleasedError`, raised on an empty token) to `null` so callers can treat it as "signed out, nothing to do".
 * Only the signed-out signal maps to `null`; any other lease failure is a real bug and is rethrown rather than being masked as a benign signed-out state.
 */
export function readLeaseBearer(lease: BearerLease): string | null {
  try {
    return lease.getBearerToken();
  } catch (cause) {
    if (cause instanceof CredentialLeaseReleasedError) {
      return null;
    }
    throw cause;
  }
}
