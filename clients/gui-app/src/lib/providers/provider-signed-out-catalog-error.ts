import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";

/**
 * The sentence every provider's signed-out verdict carried before the
 * protocol gave Reasonix its own. A signed host is released separately from
 * this renderer and builds the error from whichever protocol it pins, so a
 * host from before that change still sends this form for Reasonix, and a
 * renderer that recognised only the new one would answer such a host with the
 * generic error row and a report-issue icon - the exact state the setup CTA
 * exists to replace. Remove once no supported host predates the change.
 */
function legacyProviderSignedOutMessage(providerId: ProviderId): string {
  return `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out. Reconnect to continue.`;
}

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
  if (error === null) return false;
  const message = error.message.trim();
  return (
    message === providerSignedOutMessage(providerId) ||
    message === legacyProviderSignedOutMessage(providerId)
  );
}
