import { PROVIDER_ID_VALUES } from "@traycer/protocol/host/provider-ids";
import {
  TUI_HARNESS_ID_TO_PROVIDER_ID,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The ids an environment item is addressed by, where a host, authn and an
 * app must derive them the same way: the operating system a per-OS row is
 * for, and the harness id that keys a provider's items.
 */

export {
  HOST_OS_VALUES,
  hostOsOfPlatform,
  type HostOs,
} from "@traycer/protocol/host/environment/host-os";

/**
 * A harness id as its provider id: the shared TUI map for the harnesses
 * whose ids differ (`claude` is `claude-code`), else the provider of the
 * same name.
 */
export function providerIdOfHarness(harnessId: string): ProviderId | null {
  for (const [tuiHarnessId, providerId] of Object.entries(
    TUI_HARNESS_ID_TO_PROVIDER_ID,
  )) {
    if (tuiHarnessId === harnessId) return providerId;
  }
  return (
    PROVIDER_ID_VALUES.find((providerId) => providerId === harnessId) ?? null
  );
}

/** The reverse of {@link providerIdOfHarness}: the harness id an item is keyed by. */
export function harnessIdOfProvider(providerId: ProviderId): string {
  for (const [tuiHarnessId, mapped] of Object.entries(
    TUI_HARNESS_ID_TO_PROVIDER_ID,
  )) {
    if (mapped === providerId) return tuiHarnessId;
  }
  return providerId;
}
