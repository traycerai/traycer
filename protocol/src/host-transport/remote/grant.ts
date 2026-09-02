/** A minted attach grant ready to present to the relay. */
export interface AttachGrant {
  readonly grant: string;
  readonly expiresInSeconds: number;
}

export interface AttachGrantFailure {
  readonly detail: string;
  readonly context: string;
}

/** What a grant-provider call yielded — the session picks its response by kind. */
export type AttachGrantProvision =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  | { readonly kind: "plan-restricted" }
  | ({ readonly kind: "unavailable" } & AttachGrantFailure);

/** Injectable grant source the session calls on attach + resume + re-auth. */
export type AttachGrantProvider = () => Promise<AttachGrantProvision>;
