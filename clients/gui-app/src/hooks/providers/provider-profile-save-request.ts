/**
 * A profile's rename or recolour, as it is sent to the host
 * (`providers.setEnabled@2.2`). The request takes the environment's copy of
 * the profile as its base: the host lays the new name or colour over it. The
 * request is built here alone, so a change to its shape changes no caller.
 */
import { harnessIdOfProvider } from "@traycer/protocol/host/environment/item-identity";
import type {
  ProviderProfileAccentColor,
  ProvidersSetEnabledRequestV22,
} from "@traycer/protocol/host/provider-schemas";
import type { SettingsItemExists } from "@/hooks/environment/use-settings-save";

interface ProviderProfileSaveTarget {
  readonly providerId: ProvidersSetEnabledRequestV22["providerId"];
  readonly profileId: string;
  /**
   * The profile's `enabled` as the host's `providers.list` shows it. The
   * request requires it, so a rename or recolour restates it unchanged and
   * never enables a disabled profile.
   */
  readonly enabled: ProvidersSetEnabledRequestV22["enabled"];
  /**
   * The environment profile the host's `providers.list` says this profile
   * is (`environmentProfileId`); null for a profile only on this computer.
   */
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

/** The `managed_profile` items rename and recolour are made over. */
export const PROFILE_SAVE_KINDS = ["managed_profile"] as const;

/** The request for `save`, naming the environment profile `providers.list` gave. */
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

/**
 * `request` as it is sent: it names the environment profile only when authn
 * holds exactly one `managed_profile` item for it. Otherwise the profile is
 * this computer's own and the app expects no proposal.
 */
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
