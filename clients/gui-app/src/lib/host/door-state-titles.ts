import type { HostDoorStateKind } from "@traycer-clients/shared/host-transport/host-door-state";

/** The toast says the title alone; the door cover reads the same strings. */
export const DOOR_STATE_TITLES: Readonly<
  Record<
    Extract<HostDoorStateKind, "token-unavailable" | "token-expired">,
    string
  >
> = {
  "token-unavailable": "We can't confirm access to this computer right now",
  "token-expired": "Access needs to be renewed before you can reconnect",
};
