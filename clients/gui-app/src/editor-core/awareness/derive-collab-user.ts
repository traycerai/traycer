/** 12 caret colors, AA on both editor backgrounds, biased off the app's primary blue so a remote caret is not the local selection. */
export const COLLAB_COLOR_PALETTE: readonly string[] = [
  "#ef4444", // red-500
  "#f97316", // orange-500
  "#f59e0b", // amber-500
  "#84cc16", // lime-500
  "#10b981", // emerald-500
  "#14b8a6", // teal-500
  "#06b6d4", // cyan-500
  "#8b5cf6", // violet-500
  "#a855f7", // purple-500
  "#d946ef", // fuchsia-500
  "#ec4899", // pink-500
  "#f43f5e", // rose-500
] as const;

/** FNV-1a 32-bit so adjacent ids land in different buckets. Callers take `% palette.length` so the palette can grow without a migration. */
export function hashUserIdToColorIndex(userId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit signed space so the hash is
    // stable across V8/JSC/older ES engines.
    hash = Math.imul(hash, 0x01000193);
  }
  // Force to unsigned 32-bit before the modulo in the caller.
  return hash >>> 0;
}

/** Minimum auth-profile surface. Permissive so AuthProfile-shaped types pass without a mapper. */
export interface CollabAuthUser {
  readonly userName: string | null | undefined;
  readonly email: string | null | undefined;
}

export interface CollabUser {
  readonly name: string;
  readonly color: string;
}

function deriveStableId(user: CollabAuthUser): string {
  // Prefer email (AuthnV3 primary key). Fall back to userName then a literal
  // so two guests still get distinct colors.
  if (user.email !== null && user.email !== undefined && user.email.length > 0)
    return user.email;
  if (
    user.userName !== null &&
    user.userName !== undefined &&
    user.userName.length > 0
  )
    return user.userName;
  return "guest";
}

function deriveDisplayName(user: CollabAuthUser): string {
  if (
    user.userName !== null &&
    user.userName !== undefined &&
    user.userName.trim().length > 0
  )
    return user.userName.trim();
  if (user.email !== null && user.email !== undefined && user.email.length > 0)
    return user.email.split("@")[0] ?? "Guest";
  return "Guest";
}

/**
 * {name, color} for CollaborationCaret. Same stable id yields the same color.
 */
export function deriveCollabUser(user: CollabAuthUser): CollabUser {
  const stableId = deriveStableId(user);
  const index = hashUserIdToColorIndex(stableId) % COLLAB_COLOR_PALETTE.length;
  const color = COLLAB_COLOR_PALETTE[index] ?? COLLAB_COLOR_PALETTE[0];
  return {
    name: deriveDisplayName(user),
    color,
  };
}
