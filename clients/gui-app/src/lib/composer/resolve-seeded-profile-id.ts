import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  profileCommitId,
  resolveProfilePin,
  type RemovedProviderProfile,
} from "@/components/providers/provider-profile-model";

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
 *   to `null` (
 *   preserving it here silently ran the account on ambient while the
 *   UI/artifact kept claiming the managed profile).
 * - `settled: true` with a non-empty `profiles` array is judged by live
 *   membership (`resolveProfilePin`): a listed id passes, an alias becomes
 *   the id of the row it folded into (the same account), and an id found in
 *   no row, alias or removed account resolves to ambient as before.
 * - An id whose account a person removed (`removedProfiles`) is kept as it
 *   is: the picker shows "Was removed" on it and nothing starts on the
 *   Terminal login without the person choosing it.
 */
export function resolveSeededProfileId(
  profileId: string | null,
  profiles: ReadonlyArray<ProviderProfile> | undefined,
  removedProfiles: readonly RemovedProviderProfile[],
  settled: boolean,
): string | null {
  if (profileId === null) return null;
  if (!settled) return profileId;
  if (profiles === undefined || profiles.length === 0) return null;
  const pin = resolveProfilePin(profiles, removedProfiles, profileId);
  if (pin.kind === "row") return profileCommitId(pin.profile);
  if (pin.kind === "removed") return profileId;
  return null;
}
