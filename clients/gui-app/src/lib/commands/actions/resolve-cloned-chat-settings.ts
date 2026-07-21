import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

export interface ResolvedClonedChatSettings {
  readonly settings: ChatRunSettings;
  /** True when the source profile could not be mapped to an equivalent
   *  profile on the target host, so `settings.profileId` was reset to the
   *  ambient login instead. Never automatic beyond this notice - the caller
   *  surfaces it (toast) so the switch is never silent. */
  readonly fallenBackToAmbient: boolean;
}

// The wire array's ambient row keys itself by the literal "ambient" sentinel;
// every run/session-level profileId (chat settings included) uses `null` for
// the same concept. Mirrors `rate-limit-popover.tsx`'s identical mapping.
function normalizedProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * Profiles are host-local (a managed config dir lives on one machine), so a
 * profileId minted on the source host means nothing on the target - map by
 * the provider's own `accountUuid` identity instead (multi-profile decision
 * log's "Cross-host clone"). Pure: takes both hosts' already-fetched
 * `profiles[]` arrays, no I/O.
 */
export function mapProfileIdAcrossHosts(
  sourceAccountUuid: string | null,
  targetProfiles: ReadonlyArray<ProviderProfile>,
): string | null {
  if (sourceAccountUuid === null) return null;
  const match = targetProfiles.find(
    (profile) => profile.identity?.accountUuid === sourceAccountUuid,
  );
  return match === undefined ? null : normalizedProfileId(match);
}

function findAccountUuid(
  profiles: ReadonlyArray<ProviderProfile>,
  profileId: string | null,
): string | null {
  const profile = profiles.find(
    (candidate) => normalizedProfileId(candidate) === profileId,
  );
  return profile?.identity?.accountUuid ?? null;
}

/**
 * Resolves the `ChatRunSettings` a cloned chat should start with on
 * `targetClient`'s host, given the source chat's own settings. Harness/model/
 * permission/reasoning/tier carry over verbatim (unlike today's clone, which
 * drops them entirely); only `profileId` needs host-aware remapping.
 *
 * `sourceClient: null` means the source host is unreachable (e.g. cloning off
 * a dead tile) - there is then no way to read the source profile's identity,
 * so a non-ambient profile always falls back to ambient. Never throws: an RPC
 * failure on either host is treated the same as "no match found".
 */
export async function resolveClonedChatSettings(input: {
  readonly sourceSettings: ChatRunSettings;
  readonly sourceClient: HostClient<HostRpcRegistry> | null;
  readonly targetClient: HostClient<HostRpcRegistry>;
}): Promise<ResolvedClonedChatSettings> {
  const { sourceSettings } = input;
  if (sourceSettings.profileId === null) {
    return { settings: sourceSettings, fallenBackToAmbient: false };
  }
  const providerId = providerCliIdForHarness(sourceSettings.harnessId);
  if (providerId === null) {
    return {
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    };
  }

  const sourceAccountUuid =
    input.sourceClient === null
      ? null
      : await input.sourceClient.request("providers.list", {}).then(
          (response) =>
            findAccountUuid(
              response.providers.find((p) => p.providerId === providerId)
                ?.profiles ?? [],
              sourceSettings.profileId,
            ),
          () => null,
        );

  const targetProfiles =
    sourceAccountUuid === null
      ? []
      : await input.targetClient.request("providers.list", {}).then(
          (response) =>
            response.providers.find((p) => p.providerId === providerId)
              ?.profiles ?? [],
          () => [],
        );

  const mappedProfileId = mapProfileIdAcrossHosts(
    sourceAccountUuid,
    targetProfiles,
  );
  return {
    settings: { ...sourceSettings, profileId: mappedProfileId },
    fallenBackToAmbient: mappedProfileId === null,
  };
}
