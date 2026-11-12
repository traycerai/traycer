import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

/** These two providers offer the environment's interactive sign-in. Other
 * profiles still use their native entry flow; delivery is host-owned. */
export function usesEnvironmentSignIn(
  providerId: string,
  version: SchemaVersion | null,
): boolean {
  return (
    (providerId === "claude-code" || providerId === "codex") &&
    version?.major === 1 &&
    version.minor >= 2
  );
}

/** Match the admitted local row, never a display label or account name. */
export function installedEnvironmentProfile(
  providers: readonly {
    readonly providerId: string;
    readonly profiles: readonly ProviderProfile[];
  }[],
  providerId: string,
  environmentProfileId: string | null,
  localProfileId: string | null,
): ProviderProfile | null {
  const provider = providers.find((row) => row.providerId === providerId);
  return (
    provider?.profiles.find(
      (profile) =>
        profile.kind === "managed" &&
        profile.readability?.kind !== "unreadable" &&
        (profile.presence === undefined ||
          profile.presence.kind === "admitted") &&
        (localProfileId !== null
          ? profile.profileId === localProfileId
          : environmentProfileId !== null &&
            (profile.environmentProfileId === environmentProfileId ||
              ((profile.environmentProfileId === null ||
                profile.environmentProfileId === undefined) &&
                profile.profileId === environmentProfileId))),
    ) ?? null
  );
}

export const ACCOUNT_MISMATCH_SIGN_IN_LINE =
  "You signed in to a different account. This profile is unchanged.";
export const ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE =
  "The account on this profile could not be confirmed.";
export const REPLACE_PROFILE_ACCOUNT_LINE =
  "This changes the account on this profile everywhere it is used.";

export const SIGNED_IN_RECEIVING_LINE =
  "Signed in; this computer is still receiving it.";
