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
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
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
  readonly eligible: boolean;
  readonly entry: HostDirectoryEntry | null;
  readonly lease: HostLeaseSnapshot | null;
  readonly discovered: boolean;
  readonly poolOpen: boolean;
}): ChatOwnerPoolState {
  const { eligible, entry, lease, discovered, poolOpen } = args;
  if (!eligible || (entry !== null && !isMachineHostDirectoryEntry(entry))) {
    return "legacy";
  }
  if (lease?.status === "dead" || (discovered && entry === null))
    return "offline";
  if (lease?.status === "ready") return "ready";
  if (discovered && poolOpen && lease?.status === "connecting")
    return "connecting";
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
  const entry = useHostDirectoryEntry(eligible);
  const lease = useHostLease(eligible);
  const directory = useHostBinding()?.directory ?? null;
  const discovered = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (eligible === null || directory === null) return () => undefined;
        const subscription = directory.onChange(listener);
        return () => subscription.dispose();
      },
      [eligible, directory],
    ),
    () => eligible !== null && discoverySucceeded(directory),
  );
  const poolOpen = useRemoteSessionPollReadiness(POOL_HOST_ID);
  return ownerPoolState({
    eligible: eligible !== null,
    entry,
    lease,
    discovered,
    poolOpen,
  });
}

/** Palette items read the same verdict when invoked, since they hold no row component. */
export function readChatOwnerPoolState(
  hostId: string | null,
  directory: HostDirectoryService | null,
): ChatOwnerPoolState {
  const eligible = eligibleOwnerHost(hostId);
  if (eligible === null) return "legacy";
  return ownerPoolState({
    eligible: true,
    entry: directory?.findById(eligible) ?? null,
    lease:
      useSelectionAuthorityStore
        .getState()
        .leases.find((lease) => lease.hostId === eligible) ?? null,
    discovered: discoverySucceeded(directory),
    poolOpen: hasReadyRemoteSession(POOL_HOST_ID),
  });
}
