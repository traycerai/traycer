import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

// The wire array's ambient row keys itself by the literal "ambient" sentinel;
// every run/session-level profileId (a seeded fork target included) uses
// `null` for the same concept. Mirrors `use-profile-rate-limit-switch-prompt.ts`'s
// identical mapping.
function normalizedProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * Validates a seeded/committed `profileId` against a harness's LIVE
 * `profiles[]`, resolving a profile that no longer exists (removed,
 * tombstoned, or never real) - or that isn't supported at all by the host
 * this fork is about to run on - to ambient (`null`) instead of carrying the
 * dead id forward into a fork/composer seed. This is the visible-at-seed-
 * time counterpart to `useProviderReauthGate`'s send-time block: a chat
 * composer's own committed profile is caught by that gate when it goes
 * missing, but a fork dialog seeded fresh from a tombstoned (or
 * never-supported) source has no such gate, so the correction has to happen
 * here instead.
 *
 * - `profileId: null` (already ambient) always passes through untouched.
 * - `settled: false` (the `providers.list` query for this provider hasn't
 *   loaded yet) holds the input verbatim - never resets a valid selection
 *   mid-load. This is the ONLY case that preserves a non-null `profileId`
 *   without a live profile to back it.
 * - `settled: true` with `profiles` `undefined` or `[]` means the host has
 *   settled on "no multi-profile support for this provider" (an old host,
 *   or a flag-off/unsupported-provider host never returns anything but `[]`
 *   here - a flag-on, capable host always synthesizes at least the ambient
 *   row; see the host's `synthesizeAmbientProfile` / `resolveProfileWireEntries`).
 *   A stray `profileId` against a settled-empty list can no longer be judged
 *   "still there" - it's judged "unsupported here" instead, so it resolves
 *   to `null` (protocol-schema-contract-compat review's Major finding:
 *   preserving it here silently ran the account on ambient while the
 *   UI/artifact kept claiming the managed profile).
 * - `settled: true` with a non-empty `profiles` array is judged by live
 *   membership, as before.
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
