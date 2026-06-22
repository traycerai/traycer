/**
 * Trims an avatar URL and collapses empty/whitespace-only values to null, so
 * consumers render an image only for a real URL and otherwise fall back to
 * initials.
 */
export function normalizeAvatarUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
