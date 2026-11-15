import type { HostDoorStateKind } from "@traycer-clients/shared/host-transport/host-door-state";

/**
 * Board C1's titles for the two door states a failed Make active can be left
 * in: the toast says the title alone, and the door cover reads the same
 * strings.
 */
export const DOOR_STATE_TITLES: Readonly<
  Record<
    Extract<HostDoorStateKind, "token-unavailable" | "token-expired">,
    string
  >
> = {
  "token-unavailable": "We can't confirm access to this computer right now",
  "token-expired": "Access needs to be renewed before you can reconnect",
};
