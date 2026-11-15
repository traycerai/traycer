import type { HostDirectoryEntry } from "./host-directory";

/**
 * Both jar lanes refuse a known team owner. Unknown ownership keeps today's
 * local browser access: a cold start may stay offline for an unbounded time.
 */
export function allowsBrowserLoginSync(
  entry: Pick<HostDirectoryEntry, "owner"> | null,
): boolean {
  return entry?.owner?.kind !== "team";
}
