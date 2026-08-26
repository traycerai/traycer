import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

export interface ResolvedClonedChatSettings {
  readonly status: "ready";
  readonly settings: ChatRunSettings;
  /** True when the source profile could not be mapped to an equivalent
   *  profile on the target host, so `settings.profileId` was reset to the
   *  ambient login instead. Never automatic beyond this notice - the caller
   *  surfaces it (toast) so the switch is never silent. */
  readonly fallenBackToAmbient: boolean;
}

export interface ClonedChatProfileSelectionRequired {
  readonly status: "profile-selection-required";
  readonly providerId: ProviderId;
  readonly reason:
    | "matching-profile-disabled"
    | "no-enabled-terminal-fallback"
    | "explicit-profile-missing";
  readonly matchedProfileId: string | null;
  readonly targetProfiles: ReadonlyArray<ProviderProfile>;
}

export interface ClonedChatCatalogUnavailable {
  readonly status: "catalog-unavailable";
  readonly providerId: ProviderId;
}

export type ClonedChatProfileRecoveryRequired =
  ClonedChatProfileSelectionRequired | ClonedChatCatalogUnavailable;

export type ClonedChatSettingsResolution =
  ResolvedClonedChatSettings | ClonedChatProfileRecoveryRequired;

// The wire array's ambient row keys itself by the literal "ambient" sentinel;
// every run/session-level profileId (chat settings included) uses `null` for
// the same concept. Mirrors `rate-limit-popover.tsx`'s identical mapping.
function normalizedProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
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
 * so a non-ambient profile may fall back only to an enabled target Terminal
 * account. A disabled identity match or missing enabled Terminal fallback
 * returns the explicit-selection state instead of silently changing identity.
 * Never throws: a target catalog failure is a distinct retryable outcome;
 * source identity failure still follows the explicit Terminal fallback rules.
 */
export async function resolveClonedChatSettings(input: {
  readonly sourceSettings: ChatRunSettings;
  readonly sourceClient: HostClient<HostRpcRegistry> | null;
  readonly targetClient: HostClient<HostRpcRegistry>;
  readonly explicitTargetProfileId: {
    readonly profileId: string | null;
  } | null;
}): Promise<ClonedChatSettingsResolution> {
  const { sourceSettings } = input;
  const providerId = providerCliIdForHarness(sourceSettings.harnessId);
  if (providerId === null) {
    return {
      status: "ready",
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: sourceSettings.profileId !== null,
    };
  }

  const targetProfiles = await readProviderProfiles(
    input.targetClient,
    providerId,
  );
  if (targetProfiles === null) {
    return { status: "catalog-unavailable", providerId };
  }
  const sourceProfiles =
    input.sourceClient === null
      ? null
      : await readProviderProfiles(input.sourceClient, providerId);
  const sourceAccountUuid = findAccountUuid(
    sourceProfiles ?? [],
    sourceSettings.profileId,
  );

  return resolveTargetProfile({
    sourceSettings,
    providerId,
    targetProfiles,
    sourceAccountUuid,
    explicitTargetProfileId: input.explicitTargetProfileId,
  });
}

async function readProviderProfiles(
  client: HostClient<HostRpcRegistry>,
  providerId: ProviderId,
): Promise<ReadonlyArray<ProviderProfile> | null> {
  return client.request("providers.list", { native: null }).then(
    (response) =>
      response.providers.find((provider) => provider.providerId === providerId)
        ?.profiles ?? [],
    () => null,
  );
}

function resolveTargetProfile(input: {
  readonly sourceSettings: ChatRunSettings;
  readonly providerId: ProviderId;
  readonly targetProfiles: ReadonlyArray<ProviderProfile>;
  readonly sourceAccountUuid: string | null;
  readonly explicitTargetProfileId: {
    readonly profileId: string | null;
  } | null;
}): ClonedChatSettingsResolution {
  const { sourceSettings, providerId, targetProfiles } = input;
  if (input.explicitTargetProfileId !== null) {
    const explicitTargetProfileId = input.explicitTargetProfileId.profileId;
    const explicitProfile = targetProfiles.find(
      (profile) => normalizedProfileId(profile) === explicitTargetProfileId,
    );
    if (explicitProfile?.enabled === true) {
      return {
        status: "ready",
        settings: {
          ...sourceSettings,
          profileId: normalizedProfileId(explicitProfile),
        },
        fallenBackToAmbient: false,
      };
    }
    return profileSelectionRequired({
      providerId,
      reason:
        explicitProfile === undefined
          ? "explicit-profile-missing"
          : "matching-profile-disabled",
      matchedProfileId: explicitTargetProfileId,
      targetProfiles,
    });
  }

  const terminalProfile = targetProfiles.find(
    (profile) => profile.kind === "ambient",
  );
  if (sourceSettings.profileId === null) {
    if (terminalProfile?.enabled === true) {
      return {
        status: "ready",
        settings: sourceSettings,
        fallenBackToAmbient: false,
      };
    }
    return profileSelectionRequired({
      providerId,
      reason:
        terminalProfile === undefined
          ? "no-enabled-terminal-fallback"
          : "matching-profile-disabled",
      matchedProfileId: null,
      targetProfiles,
    });
  }

  const matchingProfile =
    input.sourceAccountUuid === null
      ? undefined
      : targetProfiles.find(
          (profile) =>
            profile.identity?.accountUuid === input.sourceAccountUuid,
        );
  if (matchingProfile !== undefined) {
    const mappedProfileId = normalizedProfileId(matchingProfile);
    if (matchingProfile.enabled) {
      return {
        status: "ready",
        settings: { ...sourceSettings, profileId: mappedProfileId },
        fallenBackToAmbient: false,
      };
    }
    return profileSelectionRequired({
      providerId,
      reason: "matching-profile-disabled",
      matchedProfileId: mappedProfileId,
      targetProfiles,
    });
  }

  if (terminalProfile?.enabled !== true) {
    return profileSelectionRequired({
      providerId,
      reason: "no-enabled-terminal-fallback",
      matchedProfileId: null,
      targetProfiles,
    });
  }
  return {
    status: "ready",
    settings: { ...sourceSettings, profileId: null },
    fallenBackToAmbient: true,
  };
}

function profileSelectionRequired(input: {
  readonly providerId: ProviderId;
  readonly reason: ClonedChatProfileSelectionRequired["reason"];
  readonly matchedProfileId: string | null;
  readonly targetProfiles: ReadonlyArray<ProviderProfile>;
}): ClonedChatProfileSelectionRequired {
  return { status: "profile-selection-required", ...input };
}
