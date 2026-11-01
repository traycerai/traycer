import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { isReportedItemKind } from "@/components/settings/environment/status-chip-page-kinds";
import {
  localRowCohort,
  type LocalRowVerb,
} from "@/components/settings/environment/local-row-cohort";
import {
  moveIsPastTheAccept,
  MOVE_STOPPED_REASONS,
} from "@/lib/environment/move-in-progress";

/**
 * Where this computer's settings stand against Personal, as the Overview's
 * settings card says it:
 *
 * - `local`: the computer has a Local row (not moved, partly moved, or
 *   stopped on some plane, the picker's own rule): `Settings on this computer
 *   only.` with the row's verb, `Move to Personal` or `Finish moving`.
 * - `moving`: the person accepted the move and the upload has not finished.
 * - `move_stopped`: the move stalled or failed before it finished, with why
 *   and how many items it has left (`Moving stopped: …`).
 * - `moved`: the person accepted the move on this computer and it finished
 *   (`Moved to Personal on …`, from `status.consent`).
 * - `other`: none of these (shared by an earlier version on every plane); the
 *   card carries only the dated lines.
 */
export type HostSettingsCardState =
  | { readonly kind: "local"; readonly verb: LocalRowVerb }
  | {
      readonly kind: "moving";
      readonly applied: number;
      readonly total: number;
    }
  | {
      readonly kind: "move_stopped";
      readonly reason: string;
      readonly left: number;
    }
  | { readonly kind: "moved"; readonly acceptedAt: number }
  | { readonly kind: "other" };

/** `Moving stopped: it timed out. 3 items left.` */
export function moveStoppedText(reason: string, left: number): string {
  return `Moving stopped: ${reason}. ${left === 1 ? "1 item" : `${String(left)} items`} left.`;
}

export function hostSettingsCardState(
  status: EnvironmentStatusResponseV11,
): HostSettingsCardState {
  const setup = status.setup;
  if (setup !== null && moveIsPastTheAccept(status)) {
    const items = status.items.filter((item) => isReportedItemKind(item.kind));
    const applied = items.filter((item) => item.status === "applied").length;
    const total = items.length + status.pendingUploads.length;
    const reason = MOVE_STOPPED_REASONS[setup.state];
    if (reason !== undefined) {
      return { kind: "move_stopped", reason, left: total - applied };
    }
    return { kind: "moving", applied, total };
  }
  const cohort = localRowCohort(status);
  if (cohort.kind === "local") {
    return { kind: "local", verb: cohort.verb ?? "move_to_personal" };
  }
  return status.consent === null
    ? { kind: "other" }
    : { kind: "moved", acceptedAt: status.consent.acceptedAt };
}
