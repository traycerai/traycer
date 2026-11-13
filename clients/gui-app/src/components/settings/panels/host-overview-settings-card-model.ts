import { unresolvedSetupText } from "@/components/settings/environment/environment-picker-model";
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

export interface HostSettingsRowOption {
  readonly value: "personal" | "local";
  readonly label: string;
  /** The sentence under the name in the menu. Hidden in the closed trigger. */
  readonly detail: string;
  readonly action: "move" | "stop_sharing" | "none";
}

const RUNS_PERSONAL = "Runs Personal";
const RUNS_OWN_SETTINGS = "Runs its own settings, not in Personal yet";

function hostSettingsOptions(
  hostName: string,
): readonly HostSettingsRowOption[] {
  return [
    {
      value: "personal",
      label: "Personal",
      detail: RUNS_PERSONAL,
      action: "move",
    },
    {
      value: "local",
      label: hostName,
      detail: "its own settings, not in Personal yet",
      action: "stop_sharing",
    },
  ];
}

export type HostSettingsRowModel =
  | { readonly kind: "loading" }
  | {
      readonly kind: "team";
      readonly environmentId: string;
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

/**
 * Settings place comes from status; the binding answers only which team. A
 * computer that runs its own settings is in no team, and no binding is read
 * for it (`useEnvironmentHostReadQuery`), so its row does not wait for one.
 */
export function hostSettingsRowModel(
  status: EnvironmentStatusResponseV11 | null,
  binding: EnvironmentHostBinding | null,
  hostName: string,
): HostSettingsRowModel {
  if (status === null) return { kind: "loading" };
  if (localRowCohort(status).kind !== "local") {
    if (binding === null) return { kind: "loading" };
    if (binding.explicit && binding.environment.ownerKind === "organization") {
      return {
        kind: "team",
        environmentId: binding.environment.environmentId,
        label: binding.environment.label,
        description: `Runs ${binding.environment.label}`,
      };
    }
  }
  const setup = unresolvedSetupText(status);
  if (setup !== null) {
    return {
      kind: "select",
      value: "local",
      description: setup,
      options: [
        { value: "local", label: hostName, detail: setup, action: "none" },
      ],
    };
  }
  const state = hostSettingsCardState(status);
  if (state.kind === "moving" || state.kind === "move_stopped")
    return { kind: "progress", progress: state };
  const value = state.kind === "local" ? "local" : "personal";
  const offerStop = planesOfferStopSharing(status.planes);
  return {
    kind: "select",
    value,
    description: value === "local" ? RUNS_OWN_SETTINGS : RUNS_PERSONAL,
    options: hostSettingsOptions(hostName).filter(
      (option) =>
        option.value === value || option.action === "move" || offerStop,
    ),
  };
}
