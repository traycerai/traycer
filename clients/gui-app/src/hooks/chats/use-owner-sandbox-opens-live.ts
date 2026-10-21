import { useCallback, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  isTeamSandboxHostDirectoryEntry,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { sandboxTileOverlay } from "@/components/hosts/sandbox-card-model";

/**
 * Whether a chat whose owner host has this directory row opens LIVE although
 * the host reads unreachable: the owner is a sandbox at rest or on its way
 * back.
 *
 * Only where the pool serves the chat at rest, the boundary `chatServingHostId`
 * routes by: a team's sandbox, in a build with a server pool (`poolPresent`).
 * A personal sandbox's chat is not served at rest, so a live tile on it would
 * fall back to the published copy anyway, without the overlay.
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
  poolPresent: boolean,
): boolean {
  if (!poolPresent || entry === null) return false;
  if (!isTeamSandboxHostDirectoryEntry(entry)) return false;
  if (!isRemoteHostDirectoryEntry(entry) || entry.sandbox === null) {
    return false;
  }
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
        : ownerSandboxOpensLive(
            readHostDirectoryEntry(ownerHostId),
            readProcessHostRpcTierPlan().pool !== null,
          ),
    [ownerHostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
