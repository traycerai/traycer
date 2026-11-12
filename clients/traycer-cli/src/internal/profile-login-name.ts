import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProfileListRow } from "../commands/profile-list";
import { callHostRpcWithDispatch, PLAIN_DISPATCH } from "./host-rpc";

/**
 * A profile created without `--label` takes the account's email prefix, the
 * GUI's default. Best effort: the profile is signed in either way, and
 * `traycer profile rename` is there if this did not land.
 */
export async function nameNewProfile(
  providerId: ProviderId,
  profile: ProfileListRow,
  requestedLabel: string | null,
): Promise<ProfileListRow> {
  if (requestedLabel !== null) return profile;
  const label = (profile.email?.split("@")[0] ?? "").trim().slice(0, 64);
  if (label.length === 0 || label === profile.label) return profile;
  try {
    await callHostRpcWithDispatch(
      "providers.setEnabled",
      {
        providerId,
        enabled: true,
        profileAction: { type: "rename", profileId: profile.profileId, label },
      },
      {
        ...PLAIN_DISPATCH,
        requiredHostMethodVersion: {
          method: "providers.setEnabled",
          version: { major: 2, minor: 1 },
        },
      },
    );
    return { ...profile, label };
  } catch {
    return profile;
  }
}
