/**
 * Friendly display name for a model pack (Default / Budget / Top / Fast).
 */
export function packDisplayName(packId: string): string {
  if (packId.length === 0) return packId;
  return packId.charAt(0).toUpperCase() + packId.slice(1);
}
