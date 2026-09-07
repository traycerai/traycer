import { PROVIDER_DISPLAY_NAMES, type ProviderId } from "./provider-schemas";

/** User-facing display copy derived from a provider's identity. */

/**
 * Fallback copy for a signed-out provider, shared by the host harnesses (the recoverable `code:"auth"` error event and the catalog's signed-out verdict) and the renderer's re-auth banner.
 * Reconnect." sent users to export a shell variable the CLI never reads, so its sentence names the real fix.
 */
export function providerSignedOutMessage(providerId: ProviderId): string {
  if (providerId === "reasonix") {
    return "Reasonix has no usable API key configured. Run reasonix setup to continue.";
  }
  return `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out. Reconnect to continue.`;
}
