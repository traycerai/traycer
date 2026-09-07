import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";

/**
 * The sentence every provider's signed-out verdict carried before the protocol gave Reasonix its own.
 * A signed host is released separately from this renderer and builds the error from whichever protocol it pins, so a host from before that change still sends this form for Reasonix, and a renderer that recognised only the new one would answer such a host.
 */
function legacyProviderSignedOutMessage(providerId: ProviderId): string {
  return `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out. Reconnect to continue.`;
}

/**
 * Whether a model-list failure is the host's "signed out" verdict for this provider, as opposed to a spawn failure, a timeout, or a rejected config.
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
