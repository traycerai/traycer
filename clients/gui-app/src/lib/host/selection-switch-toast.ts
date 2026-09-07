import { toast } from "sonner";
import type { SelectionChangeCause } from "@traycer-clients/shared/host-selection/selection-authority-contract";

/** THE one-line switch toast (status narration §"Action feedback"), and the only narration a selection move gets. */
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
