import { toast } from "sonner";
import type { SelectionChangeCause } from "@traycer-clients/shared/host-selection/selection-authority-contract";

/**
 * THE one-line switch toast (status narration §"Action feedback"), and the
 * only narration a selection move gets.
 *
 * It replaces the audit's two auto-switch toast call sites, which fired from
 * the directory's own failover machinery and could disagree with each other
 * about what had happened. There is exactly one producer now, and it does not
 * decide anything: the engine's `cause` is the verdict, because only the
 * engine knows whether landing somewhere was leaving the target or coming back
 * to it (a `fleet-shift` can legally leave `effective !== target`, so a phase
 * guess made here would report a failover that never happened).
 *
 * Silent for everything else, on purpose:
 *
 *  - `activate` is a gesture the user just made in Settings, and that surface
 *    already answers. A toast would narrate the user's own click back at them.
 *  - `deregister-clear` and `fleet-shift` are bookkeeping, not moves the user
 *    caused or needs to act on.
 *  - A `recovery` whose PREVIOUS effective was null is first provision, not a
 *    return: on a fresh install the local host becoming usable for the first
 *    time is the app starting, and "Switched to this Mac" in front of a user
 *    who has never had another host names a switch that did not happen.
 */
export function toastSelectionSwitched(input: {
  readonly cause: SelectionChangeCause;
  readonly previousEffectiveHostId: string | null;
  readonly hostLabel: string;
}): void {
  if (input.cause !== "failover" && input.cause !== "recovery") {
    return;
  }
  if (input.previousEffectiveHostId === null) {
    return;
  }
  toast.info(`Switched to ${input.hostLabel}`);
}
