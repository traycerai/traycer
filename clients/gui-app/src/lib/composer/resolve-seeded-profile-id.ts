import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  profileCommitId,
  resolveProfilePin,
  type RemovedProviderProfile,
} from "@/components/providers/provider-profile-model";

/**
 * Validates a seeded/committed `profileId` against a harness's LIVE
 * `profiles[]` before a fork or composer seed carries it forward. This is the
 * seed-time counterpart to `useProviderReauthGate`'s send-time block: a fork
 * dialog seeded fresh from a tombstoned (or never-supported) source has no
 * such gate, so the correction happens here.
 *
 * - `profileId: null` (already ambient) always passes through untouched.
 * - `settled: false` (the `providers.list` query for this provider hasn't
 *   loaded yet) holds the input verbatim - never resets a valid selection
 *   mid-load.
 * - `settled: true` resolves the id through `resolveProfilePin`, an absent
 *   list reading as no rows:
 *   - a listed id passes, and an alias becomes the id of the row it folded
 *     into (the same account);
 *   - an id whose account a person removed (`removedProfiles`) is kept as it
 *     is, even when the provider has no row left: the picker shows "Was
 *     removed" on it and nothing starts on the Terminal login without the
 *     person choosing it;
 *   - an id found in no row, alias or removed account resolves to ambient
 *     (`null`), as it always did. A settled-empty list (an old host, or a
 *     host without multi-profile support for this provider) is judged
 *     "unsupported here" the same way: preserving such an id silently ran
 *     the account on ambient while the UI kept claiming the managed profile.
 */
export function resolveSeededProfileId(
  profileId: string | null,
  profiles: ReadonlyArray<ProviderProfile> | undefined,
  removedProfiles: readonly RemovedProviderProfile[],
  settled: boolean,
): string | null {
  if (profileId === null) return null;
  if (!settled) return profileId;
  const pin = resolveProfilePin(profiles ?? [], removedProfiles, profileId);
  if (pin.kind === "row") return profileCommitId(pin.profile);
  if (pin.kind === "removed") return profileId;
  return null;
}
