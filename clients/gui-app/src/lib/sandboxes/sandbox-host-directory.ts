import { readHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * Whether a host is a sandbox, from the person's host directory; `false` for
 * any other host, and while the directory cannot say.
 *
 * A sandbox is in use while a tab holds a stream on it, and suspends once its
 * idle period passes with none, so a closed tile's stream on one is released
 * at once rather than kept warm: a warm stream would read as an attached tab
 * and hold the sandbox awake, and billed, for the whole linger.
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
