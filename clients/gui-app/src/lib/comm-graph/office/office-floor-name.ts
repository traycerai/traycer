/** What a floor's sign says. */
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
