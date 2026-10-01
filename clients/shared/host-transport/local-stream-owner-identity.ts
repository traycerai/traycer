/** Stable across local host restarts; shared by renderer and desktop owners. */
export function localStreamOwnerIdentity(
  hostId: string,
  userId: string,
): string {
  return ["local", hostId, userId].join(String.fromCharCode(0));
}
