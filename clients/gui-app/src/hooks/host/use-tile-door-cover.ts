import {
  findLease,
  isServingLease,
  ownDoorCover,
  type DoorStateCoverVariant,
} from "@/lib/host/window-narration";
import { useHostClaim } from "@/hooks/host/use-host-claim";
import { useHostDoorState } from "@/stores/host/host-door-state-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/** Only for a computer that is not the window's own: the window covers its own. */
export function useTileDoorCover(hostId: string): DoorStateCoverVariant | null {
  const doorState = useHostDoorState(hostId);
  const claim = useHostClaim(hostId, doorState);
  const windowHostId = useSelectionAuthorityStore(
    (state) => state.effectiveHostId ?? state.targetHostId,
  );
  const serving = useSelectionAuthorityStore((state) =>
    isServingLease(findLease(state.leases, hostId)),
  );
  if (hostId === windowHostId) return null;
  return ownDoorCover(doorState, serving, claim);
}
