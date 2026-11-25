import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useServingPeerHostId } from "@/lib/host/serving-decision";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

function poolComputerUnavailable(
  onPool: boolean,
  hostId: string | null,
  isReady: boolean,
): boolean {
  return onPool && (hostId === POOL_HOST_ID || !isReady);
}

/** A computer-only action can still have a ready, surface-specific target on the pool. */
export function usePoolComputerUnavailable(hostId: string | null): boolean {
  const onPool = useServingPeerHostId() === POOL_HOST_ID;
  const lease = useHostLease(onPool ? hostId : null);
  return poolComputerUnavailable(onPool, hostId, lease?.status === "ready");
}

export function readPoolComputerUnavailable(hostId: string | null): boolean {
  const { servingPeer, leases } = useSelectionAuthorityStore.getState();
  return poolComputerUnavailable(
    servingPeer?.kind === "pool",
    hostId,
    leases.some((lease) => lease.hostId === hostId && lease.status === "ready"),
  );
}
