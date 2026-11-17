import { PROVIDER_ID_VALUES } from "@traycer/protocol/host/provider-ids";
import {
  TUI_HARNESS_ID_TO_PROVIDER_ID,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

// A host, authn and an app must derive these ids the same way.

export {
  HOST_OS_VALUES,
  hostOsOfPlatform,
  type HostOs,
} from "@traycer/protocol/host/environment/host-os";

/** The shared TUI map where ids differ (`claude` is `claude-code`), else the same name. */
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

export function harnessIdOfProvider(providerId: ProviderId): string {
  for (const [tuiHarnessId, mapped] of Object.entries(
    TUI_HARNESS_ID_TO_PROVIDER_ID,
  )) {
    if (mapped === providerId) return tuiHarnessId;
  }
  return providerId;
}
