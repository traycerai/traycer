import type { FatalErrorDetails } from "../../framework/ws-protocol";

/** A minted attach grant ready to present to the relay. */
export interface AttachGrant {
  readonly grant: string;
  readonly expiresInSeconds: number;
}

export interface AttachGrantFailure {
  readonly detail: string;
  readonly context: string;
}

/**
 * What a grant-provider call yielded — the session picks its response by kind:
 *  - `ok`          — dial with this grant.
 *  - `unavailable` — no grant this time (signed out, a rejected bearer, an
 *                    authn outage): reconnect backoff.
 *  - `refused`     — authn refused the mint with a verdict a retry cannot
 *                    change (a sandbox frozen for lack of credits): the
 *                    session ends on `fatal`, exactly as on a host fatal.
 */
export type AttachGrantProvision =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  | ({ readonly kind: "unavailable" } & AttachGrantFailure)
  | ({
      readonly kind: "refused";
      readonly fatal: FatalErrorDetails;
    } & AttachGrantFailure);

/** Injectable grant source the session calls on attach + resume + re-auth. */
export type AttachGrantProvider = () => Promise<AttachGrantProvision>;
