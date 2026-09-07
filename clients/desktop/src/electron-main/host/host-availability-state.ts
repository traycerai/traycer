import type { LiveHostAvailability } from "@traycer-clients/shared/host-client/host-directory";
import type { PublishedHostPresence } from "./host-endpoint-reachability";

/** `busy` can degrade, never become "no host". */
export const DEMOTE_AFTER_CONSECUTIVE_BUSY = 2;

export interface HostAvailabilityState {
  /** `null` is the only value that may reach the renderer as a dead host. */
  readonly published: LiveHostAvailability | null;
  readonly consecutiveBusy: number;
  /** Last observation was degraded, including during the hysteresis hold while `published` is still `available`. */
  readonly degraded: boolean;
}

export const INITIAL_HOST_AVAILABILITY_STATE: HostAvailabilityState = {
  published: null,
  consecutiveBusy: 0,
  degraded: false,
};

export function foldHostAvailability(
  state: HostAvailabilityState,
  presence: PublishedHostPresence,
): HostAvailabilityState {
  if (presence === "absent") {
    return INITIAL_HOST_AVAILABILITY_STATE;
  }
  if (presence === "available") {
    return { published: "available", consecutiveBusy: 0, degraded: false };
  }
  const consecutiveBusy = state.consecutiveBusy + 1;
  const holdsAvailable =
    state.published === "available" &&
    consecutiveBusy < DEMOTE_AFTER_CONSECUTIVE_BUSY;
  return {
    published: holdsAvailable ? "available" : "busy",
    consecutiveBusy,
    degraded: true,
  };
}

export function needsReprobe(state: HostAvailabilityState): boolean {
  return state.degraded;
}
