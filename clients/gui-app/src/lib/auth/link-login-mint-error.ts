import type { MintLinkLoginCodeFetchResult } from "@traycer-clients/shared/auth/link-login";

export type LinkLoginMintFailureKind = Exclude<
  MintLinkLoginCodeFetchResult["kind"],
  "ok"
>;

const MINT_FAILURE_MESSAGES: Record<LinkLoginMintFailureKind, string> = {
  unauthorized: "Your session could not authorize a link code.",
  "claim-pending": "A sign-in request is already awaiting your approval.",
  "no-session-family":
    "This session can't create link codes — sign in again first.",
  "network-error": "Could not reach the sign-in service.",
};

/**
 * A mint refusal with its wire meaning intact: surfaces switch on `kind`
 * rather than parsing the human message. `claim-pending` in particular is a
 * STATE to render (a claim awaits the user's decision, possibly on another
 * surface), never an error card with a stale QR behind it.
 */
export class LinkLoginMintError extends Error {
  readonly kind: LinkLoginMintFailureKind;

  constructor(kind: LinkLoginMintFailureKind) {
    super(MINT_FAILURE_MESSAGES[kind]);
    this.name = "LinkLoginMintError";
    this.kind = kind;
  }
}
