export type SecretReadResult =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly reason: "denied" | "unavailable" };
