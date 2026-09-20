/**
 * The host's "I could not read your provider settings" verdict, recognised
 * by its message prefix.
 *
 * The same shape as `isProviderSignedOutCatalogError`, and for the same
 * reason: the host raises this as the generic RPC error, so the MESSAGE is
 * the only discriminator. A dedicated `RPC_ERROR_CODES` member would be a
 * `@traycer/protocol` export, which would make this renderer's fix wait on an
 * OSS merge and a submodule pin bump for one sentence.
 *
 * Unlike that helper, the contract cannot be a shared protocol function -
 * the producer is host-local (`traycer-host/src/domain/providers/
 * provider-overrides-store.ts`, `PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX`).
 * A host test reads THIS file and asserts the two literals are equal, so the
 * drift is caught on the side that can see both repositories.
 *
 * A host that predates the verdict never sends it, so this branch is simply
 * inert against one - which is what lets it ship without a negotiated
 * version.
 */
export const PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX =
  "Provider settings could not be read";

/** What the panel shows instead of "the host may need to be updated" - the host is fine, the file is not. */
export const PROVIDER_SETTINGS_UNREADABLE_COPY =
  "Provider settings could not be read on this host. Retry.";

/**
 * Whether this `providers.list` rejection is that verdict.
 *
 * A PREFIX test, not equality: the host appends what it knows about the
 * fault after the fixed opening, and the whole point of keying on the
 * opening is that the tail can improve without this renderer being the thing
 * that has to ship first.
 */
export function isProviderSettingsUnreadableError(
  error: { readonly message: string } | null,
): boolean {
  if (error === null) return false;
  return error.message
    .trim()
    .startsWith(PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX);
}
