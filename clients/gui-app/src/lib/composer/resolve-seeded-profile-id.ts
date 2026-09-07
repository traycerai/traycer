import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

// The wire array's ambient row keys itself by the literal "ambient" sentinel; every run/session-level profileId (a seeded fork target included) uses `null` for the same concept.
// Mirrors `use-profile-rate-limit-switch-prompt.ts`'s identical mapping.
function normalizedProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * Validates a seeded/committed `profileId` against a harness's LIVE `profiles[]`, resolving a profile that no longer exists (removed, tombstoned, or never real) - or that isn't supported at all by the host this fork is about to run on - to ambient (`null`).
 */
export function resolveSeededProfileId(
  profileId: string | null,
  profiles: ReadonlyArray<ProviderProfile> | undefined,
  settled: boolean,
): string | null {
  if (profileId === null) return null;
  if (!settled) return profileId;
  if (profiles === undefined || profiles.length === 0) return null;
  const stillActive = profiles.some(
    (profile) => normalizedProfileId(profile) === profileId,
  );
  return stillActive ? profileId : null;
}
