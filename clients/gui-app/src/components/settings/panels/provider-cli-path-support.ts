import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Whether the user may point this provider at an executable of their own
 * ("Add custom path" in the CLI section).
 *
 * A deliberate mirror of the host's `providerSupportsCustomCliPath`
 * (`traycer-host/src/domain/providers/provider-cli-path-support.ts`), which is
 * an id check with no capability on the wire to read instead - the same shape
 * as `providerSupportsManagedProfiles`. The host holds the line: it refuses the
 * write and reads a path saved earlier as absent. This side only holds the
 * control, so the user is told why instead of meeting the refusal.
 *
 * Antigravity is the one provider without it. Its agent runs as
 * `agy_acp_server`, the ACP server its managed pack ships with the companion
 * that server launches; the `agy` CLI users have installed is a different
 * program, and a path to it could only fail to launch.
 */
export function providerSupportsCustomCliPath(providerId: ProviderId): boolean {
  return providerId !== "antigravity";
}

/** Why "Add custom path" is held for this provider, or null when it is not. */
export function providerCustomCliPathHeldReason(
  providerId: ProviderId,
): string | null {
  if (providerSupportsCustomCliPath(providerId)) return null;
  return `${PROVIDER_DISPLAY_NAMES[providerId]} runs its own ACP server from its managed download, so a custom CLI path isn't supported.`;
}
