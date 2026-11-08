import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { planesOfferStopSharing } from "@/components/settings/move/status-planes";
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
 * Where this computer's settings stand against Personal, from its status:
 *
 * - `local`: the computer has a Local row (not moved, partly moved, or
 *   stopped on some plane, the picker's own rule), with the row's verb.
 * - `moving`: the person accepted the move and the upload has not finished.
 * - `move_stopped`: the move stalled or failed before it finished, with why
 *   and how many items it has left (`Moving stopped: …`).
 * - `moved`: the person accepted the move on this computer and it finished
 *   (the accepted date is from `status.consent`).
 * - `other`: none of these (shared by an earlier version on every plane).
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

interface HostSettingsRowOption {
  readonly value: "personal" | "local";
  readonly label: string;
  readonly action: "move" | "stop_sharing";
}

const HOST_SETTINGS_OPTIONS: readonly HostSettingsRowOption[] = [
  {
    value: "personal",
    label: "Personal",
    action: "move",
  },
  {
    value: "local",
    label: "This computer only",
    action: "stop_sharing",
  },
];

type HostSettingsRowModel =
  | { readonly kind: "loading" }
  | {
      readonly kind: "team";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "progress";
      readonly progress: Extract<
        HostSettingsCardState,
        { kind: "moving" | "move_stopped" }
      >;
    }
  | {
      readonly kind: "select";
      readonly value: "personal" | "local";
      readonly description: string;
      readonly options: readonly HostSettingsRowOption[];
    };

/** Settings place comes from status; the binding answers only which team. */
export function hostSettingsRowModel(
  status: EnvironmentStatusResponseV11 | null,
  binding: EnvironmentHostBinding | null,
): HostSettingsRowModel {
  if (status === null || binding === null) return { kind: "loading" };
  if (binding.explicit && binding.environment.ownerKind === "organization") {
    const label = binding.environment.label;
    const possessive = label.endsWith("s") ? `${label}'` : `${label}'s`;
    return { kind: "team", label, description: `Runs ${possessive} settings.` };
  }
  const state = hostSettingsCardState(status);
  if (state.kind === "moving" || state.kind === "move_stopped")
    return { kind: "progress", progress: state };
  const value = state.kind === "local" ? "local" : "personal";
  const offerStop = planesOfferStopSharing(status.planes);
  return {
    kind: "select",
    value,
    description:
      value === "local"
        ? "Uses the settings stored on this computer. Changes stay here."
        : "Your Personal settings reach this computer.",
    options: HOST_SETTINGS_OPTIONS.filter(
      (option) =>
        option.value === value || option.action === "move" || offerStop,
    ),
  };
}
