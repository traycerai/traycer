import { clearHostDoorState } from "@/stores/host/host-door-state-store";

/** The state its old answer raised no longer holds; the next open mints a fresh token. */
export function noteHostMembershipChanged(hostId: string): void {
  clearHostDoorState(hostId);
}
