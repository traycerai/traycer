import { useCallback, useSyncExternalStore } from "react";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  isMachineHostDirectoryEntry,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  hasReadyRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote";
import { useHostBinding } from "@/lib/host";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

export type ChatOwnerPoolState =
  | "legacy"
  | "offline"
  | "connecting"
  | "ready"
  | "holding";

function ownerPoolState(args: {
  readonly entry: HostDirectoryEntry | null;
  readonly lease: HostLeaseSnapshot | null;
  readonly discovered: boolean;
  readonly poolOpen: boolean;
}): ChatOwnerPoolState {
  const { entry, lease, discovered, poolOpen } = args;
  if (entry !== null && !isMachineHostDirectoryEntry(entry)) {
    return "legacy";
  }
  // The directory and lease arrive independently. A retained lease does not
  // settle discovery, and a tile already reading the pool can hold its view.
  if (!discovered) return "holding";
  if (lease?.status === "dead" || entry === null) return "offline";
  if (lease?.status === "ready") return "ready";
  if (poolOpen && lease?.status === "connecting") return "connecting";
  return "holding";
}

function eligibleOwnerHost(hostId: string | null): string | null {
  return readProcessHostRpcTierPlan().pool === null ? null : hostId;
}

function discoverySucceeded(directory: HostDirectoryService | null): boolean {
  return (
    directory !== null &&
    directory.hasConcludedDiscovery() &&
    !directory.hasFailedDiscovery()
  );
}

/** The authority's lease can move a published machine chat without a witness update. */
export function useChatOwnerPoolState(
  hostId: string | null,
): ChatOwnerPoolState {
  const eligible = eligibleOwnerHost(hostId);
  const directory = useHostBinding()?.directory ?? null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (eligible === null) return () => undefined;
      const stopListeningToAuthority =
        useSelectionAuthorityStore.subscribe(listener);
      const stopListeningToSessions = subscribeRemoteSessionReadiness(listener);
      const directorySubscription = directory?.onChange(listener);
      return () => {
        directorySubscription?.dispose();
        stopListeningToSessions();
        stopListeningToAuthority();
      };
    },
    [eligible, directory],
  );
  const read = () => readChatOwnerPoolState(eligible, directory);
  return useSyncExternalStore(subscribe, read, read);
}

/** Palette items read the same verdict when invoked, since they hold no row component. */
export function readChatOwnerPoolState(
  hostId: string | null,
  directory: HostDirectoryService | null,
): ChatOwnerPoolState {
  const eligible = eligibleOwnerHost(hostId);
  if (eligible === null) return "legacy";
  return ownerPoolState({
    entry: directory?.findById(eligible) ?? null,
    lease:
      useSelectionAuthorityStore
        .getState()
        .leases.find((lease) => lease.hostId === eligible) ?? null,
    discovered: discoverySucceeded(directory),
    poolOpen: hasReadyRemoteSession(POOL_HOST_ID),
  });
}
