import { readHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * Whether a host is a sandbox, from the person's host directory; `false` for
 * any other host, and while the directory cannot say.
 *
 * A closed tile's stream on a sandbox is released at once rather than kept
 * warm: a sandbox host older than the rule that viewing isn't use counts an
 * open stream as use, and a warm stream would hold it awake, and billed, for
 * the whole linger.
 */
export function isSandboxHostId(hostId: string | null): boolean {
  if (hostId === null) return false;
  const entry = readHostDirectoryEntry(hostId);
  return (
    entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.sandbox !== null
  );
}
