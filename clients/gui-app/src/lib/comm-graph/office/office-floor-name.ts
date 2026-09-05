/**
 * What a floor's sign says.
 *
 * The host's own display name where the directory knows it, a short prefix of
 * the id where it does not. Never the raw id in full: it is long, opaque, and
 * the sign is two tiles wide.
 */
const SHORT_ID_LENGTH = 8;

export function officeFloorName(
  hostId: string | null,
  hostNameById: ReadonlyMap<string, string>,
): string {
  // A record predating host binding belongs to no machine, and saying so beats
  // inventing one.
  if (hostId === null) return "Unattributed";
  const name = hostNameById.get(hostId);
  if (name !== undefined && name.length > 0) return name;
  return hostId.slice(0, SHORT_ID_LENGTH);
}
