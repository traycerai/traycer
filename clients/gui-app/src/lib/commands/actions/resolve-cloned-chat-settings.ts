import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { fallbackPermissionMode } from "@/components/home/data/landing-options";

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
  | ClonedChatProfileSelectionRequired
  | ClonedChatCatalogUnavailable;

export type ClonedChatSettingsResolution =
  | ResolvedClonedChatSettings
  | ClonedChatProfileRecoveryRequired;

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
 * reasoning/tier carry over verbatim (unlike today's clone, which drops them
 * entirely); `profileId` needs host-aware remapping, and `permissionMode` needs
 * host-aware CLAMPING - see {@link permissionModeForTarget}, which is what
 * stops an `auto` chat failing the create on a target below that line.
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
  // Clamp the MODE against the target's catalog before anything else, so every
  // return below carries a tuple that host can actually accept.
  const sourceSettings = await permissionModeForTarget(
    input.sourceSettings,
    input.targetClient,
  );
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

/**
 * The source chat's settings with `permissionMode` resolved against the TARGET
 * host's catalog.
 *
 * The clone hands its tuple straight to the target's `epic.createChat`, so a
 * mode that host cannot spell fails the create outright - and `auto` is exactly
 * such a mode on any host below the line that introduced it. The composer and
 * session-import paths already demote this case; the clone carried it verbatim,
 * which is the one path where the whole operation is lost rather than degraded.
 *
 * **Demotes only on POSITIVE evidence**, and that asymmetry is deliberate.
 * Proof is one row answering: the TARGET row named by `settings.harnessId`,
 * present in the catalog and not listing `auto`. Two other shapes are not
 * proof and leave the mode alone - a catalog read that FAILS (guessing from a
 * transient blip would silently change a durable setting), and a catalog with
 * no row for that harness at all (which says the target lacks the harness, a
 * different and honest failure the create will surface itself). This
 * function's neighbour takes the same line one field over - a failed
 * `providers.list` becomes the explicit, retryable `catalog-unavailable`
 * rather than an assumed ambient profile.
 *
 * `fallbackPermissionMode` is the shared one-way demotion (`auto` ->
 * `auto_accept_edits`): dropping the judge is the honest half-measure, where a
 * walk to the safest supported mode would land on `supervised` and make a
 * cloned chat stricter than the one it came from.
 */
async function permissionModeForTarget(
  settings: ChatRunSettings,
  targetClient: HostClient<HostRpcRegistry>,
): Promise<ChatRunSettings> {
  if (settings.permissionMode !== "auto") return settings;
  const harnesses = await targetClient
    .request("agent.gui.listHarnesses", {})
    .then(
      (response) => response.harnesses,
      () => null,
    );
  if (harnesses === null) return settings;
  // The row this chat will actually RUN on, not the catalog as a whole. A
  // catalog-wide `some()` preserves `auto` whenever ANY target harness offers
  // it, which is the wrong question on a mixed target: the create carries one
  // `harnessId`, and `assertPermissionModeSupported` on the host judges the
  // tuple against that harness alone. A chat on a harness without `auto`
  // cloned onto a host where some other harness has it would still be rejected.
  const targetRow = harnesses.find(
    (harness) => harness.id === settings.harnessId,
  );
  // No row is not positive evidence about the MODE - it says the target has no
  // such harness at all, which fails the create for a different and honest
  // reason. Clamping here would quietly rewrite the mode on the way to an
  // error about something else.
  if (targetRow === undefined) return settings;
  if (targetRow.supportedPermissionModes.includes("auto")) return settings;
  return {
    ...settings,
    permissionMode: fallbackPermissionMode(settings.permissionMode),
  };
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
