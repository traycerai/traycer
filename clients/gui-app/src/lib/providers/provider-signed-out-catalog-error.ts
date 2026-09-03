import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";

/**
 * Whether a model-list failure is the host's "signed out" verdict for this
 * provider, as opposed to a spawn failure, a timeout, or a rejected config.
 *
 * The host raises that verdict as `HarnessCatalogAuthError`, which crosses the
 * wire as a plain error with no code - the MESSAGE is the only discriminator,
 * and `providerSignedOutMessage` is its single producer on both sides of the
 * wire (the host builds the error from it, the reauth banner renders it). An
 * exact match against that same helper is therefore a contract, not a text
 * heuristic; it just has to be kept in step if the host ever starts sending a
 * code, at which point this becomes the code check.
 */
export function isProviderSignedOutCatalogError(
  providerId: ProviderId,
  error: { readonly message: string } | null,
): boolean {
  return (
    error !== null &&
    error.message.trim() === providerSignedOutMessage(providerId)
  );
}
