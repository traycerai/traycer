import { PROVIDER_DISPLAY_NAMES, type ProviderId } from "./provider-schemas";

/**
 * User-facing display copy derived from a provider's identity. Lives apart from
 * the schema file so behavior (string building) stays out of the wire-type
 * definitions, while remaining reachable by both the host and the renderer.
 */

/**
 * Fallback copy for a signed-out provider, shared by the host harnesses (the
 * recoverable `code:"auth"` error event and the catalog's signed-out verdict)
 * and the renderer's re-auth banner. The banner renders the real reconnect
 * actions; this only shows in the brief window before it mounts, and wherever
 * a surface has no actions to offer (a notification body, the model picker's
 * error row).
 *
 * Reasonix has no account to reconnect: it reads provider API keys from its
 * own `<reasonix-home>/.env` and from nowhere else, and the only way to put
 * one there is its terminal wizard. "Signed out. Reconnect." sent users to
 * export a shell variable the CLI never reads, so its sentence names the real
 * fix. The renderer matches this string exactly to recognise the verdict
 * (`isProviderSignedOutCatalogError`), which is why this function must stay
 * the single producer for every provider.
 */
export function providerSignedOutMessage(providerId: ProviderId): string {
  if (providerId === "reasonix") {
    return "Reasonix has no API key configured. Run reasonix setup to continue.";
  }
  return `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out. Reconnect to continue.`;
}
