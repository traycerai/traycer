/**
 * What a keystore read comes back with. `denied` is the user (or the OS on
 * their behalf) saying no to the prompt and is retryable; `unavailable` is a
 * key that is not there to be read - no keyring, no item, no binary.
 */
export type SecretReadResult =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly reason: "denied" | "unavailable" };
