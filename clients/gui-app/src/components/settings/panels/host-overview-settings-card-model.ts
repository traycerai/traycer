import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { isReportedItemKind } from "@/components/settings/environment/status-chip-page-kinds";
import {
  localRowCohort,
  type LocalRowVerb,
} from "@/components/settings/environment/local-row-cohort";

/**
 * Where this computer's settings stand against Personal, as the Overview's
 * settings card says it:
 *
 * - `local`: the computer has a Local row (not moved, partly moved, or
 *   stopped on some plane, the picker's own rule): `Settings on this computer
 *   only.` with the row's verb, `Move to Personal` or `Finish moving`.
 * - `moving`: the person accepted the move and the upload has not finished.
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
  | { readonly kind: "moved"; readonly acceptedAt: number }
  | { readonly kind: "other" };

export function hostSettingsCardState(
  status: EnvironmentStatusResponseV11,
): HostSettingsCardState {
  const setup = status.setup;
  if (
    setup !== null &&
    setup.stage === "moving_settings" &&
    setup.state !== "awaiting_consent"
  ) {
    const items = status.items.filter((item) => isReportedItemKind(item.kind));
    return {
      kind: "moving",
      applied: items.filter((item) => item.status === "applied").length,
      total: items.length + status.pendingUploads.length,
    };
  }
  const cohort = localRowCohort(status);
  if (cohort !== null && cohort.kind === "local") {
    return { kind: "local", verb: cohort.verb ?? "move_to_personal" };
  }
  return status.consent === null
    ? { kind: "other" }
    : { kind: "moved", acceptedAt: status.consent.acceptedAt };
}
