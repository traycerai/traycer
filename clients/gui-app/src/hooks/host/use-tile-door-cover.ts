import {
  findLease,
  isServingLease,
  ownDoorCover,
  type DoorStateCoverVariant,
} from "@/lib/host/window-narration";
import { useHostDoorState } from "@/stores/host/host-door-state-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The door cover a tile draws for its own computer, or `null`. Only for a
 * computer that is not the window's own: the window's computer is covered by
 * the window itself.
 */
export function useTileDoorCover(hostId: string): DoorStateCoverVariant | null {
  const doorState = useHostDoorState(hostId);
  const windowHostId = useSelectionAuthorityStore(
    (state) => state.effectiveHostId ?? state.targetHostId,
  );
  const serving = useSelectionAuthorityStore((state) =>
    isServingLease(findLease(state.leases, hostId)),
  );
  if (hostId === windowHostId) return null;
  return ownDoorCover(doorState, serving);
}
