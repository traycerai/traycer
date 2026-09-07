import { PROVIDER_PROFILE_ACCENT_COLORS } from "@traycer/protocol/host/provider-schemas";

/**
 * Deterministic accent palette for provider profile badges - the same selectable palette (`PROVIDER_PROFILE_ACCENT_COLORS`) the accent-color swatch grid offers, so a profile without a host-assigned color still lands on a color the user could have picked.
 */
const PROFILE_ACCENT_PALETTE: readonly string[] =
  PROVIDER_PROFILE_ACCENT_COLORS;

/**
 * FNV-1a 32-bit - the same idiom `hashUserIdToColorIndex` uses for collab carets, kept as an independent copy since profile ids and collab user ids are unrelated identity spaces with independently evolving palettes.
 */
function hashProfileIdToColorIndex(profileId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < profileId.length; i++) {
    hash ^= profileId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Resolves the accent color to render for a profile badge.
 * Prefers the host-assigned `accentColor` (persisted on the profile record at creation); falls back to a deterministic palette hash of `profileId` when the host hasn't supplied one yet (old host builds predate the wire field - see `providerProfileSchema`'s.
 */
export function resolveProfileAccentColor(
  profileId: string,
  accentColor: string | null,
): string {
  if (accentColor !== null) return accentColor;
  const index =
    hashProfileIdToColorIndex(profileId) % PROFILE_ACCENT_PALETTE.length;
  return PROFILE_ACCENT_PALETTE[index] ?? PROFILE_ACCENT_PALETTE[0];
}
