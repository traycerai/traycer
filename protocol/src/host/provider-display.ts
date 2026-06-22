import { PROVIDER_DISPLAY_NAMES, type ProviderId } from "./provider-schemas";

/**
 * User-facing display copy derived from a provider's identity. Lives apart from
 * the schema file so behavior (string building) stays out of the wire-type
 * definitions, while remaining reachable by both the host and the renderer.
 */

/**
 * Fallback copy for a signed-out provider, shared by the host harnesses (the
 * recoverable `code:"auth"` error event) and the renderer's re-auth banner. The
 * banner renders the real reconnect actions; this only shows in the brief window
 * before it mounts.
 */
export function providerSignedOutMessage(providerId: ProviderId): string {
  return `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out. Reconnect to continue.`;
}
