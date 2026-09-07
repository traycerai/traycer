import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  leaseEquals,
  type HostLeaseSnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/** Null is unpublished, not a lease value. */
function selectedLeaseEquals(
  a: HostLeaseSnapshot | null,
  b: HostLeaseSnapshot | null,
): boolean {
  if (a === null || b === null) return a === b;
  return leaseEquals(a, b);
}

/** Null is unpublished, not dead. */
export function useHostLease(hostId: string | null): HostLeaseSnapshot | null {
  return useStoreWithEqualityFn(
    useSelectionAuthorityStore,
    (state) =>
      hostId === null
        ? null
        : (state.leases.find((lease) => lease.hostId === hostId) ?? null),
    selectedLeaseEquals,
  );
}

/** Fleet leases. Fresh array per publish; useShallow only helps if the selector derives primitives. */
export function useHostLeases(): readonly HostLeaseSnapshot[] {
  return useSelectionAuthorityStore((state) => state.leases);
}
