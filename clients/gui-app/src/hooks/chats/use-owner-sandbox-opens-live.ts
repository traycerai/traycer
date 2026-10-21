import { useCallback, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { sandboxTileOverlay } from "@/components/hosts/sandbox-card-model";

/**
 * Whether a chat whose owner host has this directory row opens LIVE although
 * the host reads unreachable: the owner is a sandbox at rest or on its way
 * back.
 *
 * Wakeable is exactly what a live tile on that sandbox frames as asleep
 * (suspending, suspended, stopping, stopped, released) or moving (resuming,
 * starting): the tile it opens shows the at-rest notice and the Resume or
 * Start overlay, which is the designed state. A frozen sandbox, a failed,
 * destroying, destroyed or still-creating one, a row with no sandbox facts
 * and a missing row all answer `false` and keep the published copy.
 */
export function ownerSandboxOpensLive(
  entry: HostDirectoryEntry | null,
): boolean {
  if (entry === null || !isRemoteHostDirectoryEntry(entry)) return false;
  if (entry.sandbox === null) return false;
  const overlay = sandboxTileOverlay(entry.sandbox.state, entry.sandbox.frozen);
  return (
    overlay !== null && (overlay.kind === "asleep" || overlay.kind === "moving")
  );
}

/**
 * {@link ownerSandboxOpensLive} for the owner host a chat-open decision reads.
 *
 * Used ONLY by the sites that feed the chat open decision, beside their
 * `useHostReachability` read, and never folded into that hook: its other
 * consumers (pickers, agent create, terminal open, tab-open checks) dial the
 * host, and a suspended sandbox must not read reachable there. A chat is
 * different because the pool serves it at rest.
 *
 * Reads the shared connection registry rather than `useHostDirectoryEntry`
 * for the reason `useHostRefusesEpicStore` gives: sidebar rows mount with no
 * `<HostRuntimeProvider>`. The snapshot is a primitive, so a row only
 * re-renders when this answer moves.
 */
export function useOwnerSandboxOpensLive(ownerHostId: string | null): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      ownerHostId === null
        ? () => undefined
        : subscribeHostRowChanged(ownerHostId, listener),
    [ownerHostId],
  );
  const getSnapshot = useCallback(
    () =>
      ownerHostId === null
        ? false
        : ownerSandboxOpensLive(readHostDirectoryEntry(ownerHostId)),
    [ownerHostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
