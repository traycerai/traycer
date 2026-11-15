import type { RemoteHostDirectoryEntry } from "./remote-fetcher";

/**
 * A registry host the person owns themself: neither a sandbox nor a team's
 * computer. Ownership, not the credential a connection opens with, decides
 * which of the person's own data (the browser's logins) may reach a host.
 */
export function isPersonalRemoteHost(
  entry: Pick<RemoteHostDirectoryEntry, "owner" | "sandbox">,
): boolean {
  return entry.sandbox === null && entry.owner?.kind !== "team";
}
