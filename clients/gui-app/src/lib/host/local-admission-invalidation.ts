import { clearHostDoorState } from "@/stores/host/host-door-state-store";

/**
 * A confirmed ownership or membership change for `hostId`: the state its old
 * answer raised no longer holds, and the next open mints a fresh token.
 */
export function noteHostMembershipChanged(hostId: string): void {
  clearHostDoorState(hostId);
}
