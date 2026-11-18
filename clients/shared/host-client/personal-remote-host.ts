import type { RemoteHostDirectoryEntry } from "./remote-fetcher";

/**
 * Ownership, not the credential a connection opens with, decides which of the
 * person's own data may reach a host.
 */
export function isPersonalRemoteHost(
  entry: Pick<RemoteHostDirectoryEntry, "owner" | "sandbox">,
): boolean {
  return entry.sandbox === null && entry.owner?.kind !== "team";
}
