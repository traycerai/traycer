// The host lays the new name or colour over the environment's copy of the profile.
import { harnessIdOfProvider } from "@traycer/protocol/host/environment/item-identity";
import type {
  ProviderProfileAccentColor,
  ProvidersSetEnabledRequestV22,
} from "@traycer/protocol/host/provider-schemas";
import type { SettingsItemExists } from "@/hooks/environment/use-settings-save";

interface ProviderProfileSaveTarget {
  readonly providerId: ProvidersSetEnabledRequestV22["providerId"];
  readonly profileId: string;
  /** Restated unchanged, so a rename never enables a disabled profile. */
  readonly enabled: ProvidersSetEnabledRequestV22["enabled"];
  readonly environmentProfileId: string | null;
}

export type ProviderProfileSave = ProviderProfileSaveTarget &
  (
    | { readonly type: "rename"; readonly label: string }
    | {
        readonly type: "recolor";
        readonly accentColor: ProviderProfileAccentColor;
      }
  );

export const PROFILE_SAVE_KINDS = ["managed_profile"] as const;

export function providerProfileSaveRequest(
  save: ProviderProfileSave,
): ProvidersSetEnabledRequestV22 {
  const environmentProfileId = save.environmentProfileId;
  return {
    providerId: save.providerId,
    enabled: save.enabled,
    profileAction:
      save.type === "rename"
        ? {
            type: "rename",
            profileId: save.profileId,
            label: save.label,
            environmentProfileId,
          }
        : {
            type: "recolor",
            profileId: save.profileId,
            accentColor: save.accentColor,
            environmentProfileId,
          },
  };
}

/** Names the environment profile only when authn holds exactly one `managed_profile` item for it. */
export async function confirmEnvironmentProfile(
  request: ProvidersSetEnabledRequestV22,
  itemExists: SettingsItemExists,
): Promise<ProvidersSetEnabledRequestV22> {
  const action = request.profileAction;
  if (action === null || action.type === "remove") return request;
  if (action.type === "acknowledgeAmbientDrift") return request;
  const named = action.environmentProfileId;
  if (named === null) return request;
  const key = `${harnessIdOfProvider(request.providerId)}:${named}`;
  if (await itemExists(key)) return request;
  return {
    ...request,
    profileAction: { ...action, environmentProfileId: null },
  };
}
