/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ The live update pill).
 * Update that file whenever this settings surface changes.
 */
import { operationProgressPercent } from "@/components/home/host-update-operation-copy";
import { retainedBadgeWord } from "@/components/settings/host-scope/host-option-model";
import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The Overview header's live update pill: what an update is doing, for someone
 * looking at any tab but Status. Status draws the update card itself, so the
 * pill is never drawn there. That is the caller's rule, not this module's.
 *
 * The pill only reports. Clicking it selects Status, where the controls are.
 */
export type HostOverviewUpdatePillTone =
  | "info"
  | "warning"
  | "destructive"
  | "success"
  | "muted";

export interface HostOverviewUpdatePill {
  readonly label: string;
  readonly tone: HostOverviewUpdatePillTone;
}

interface UpdatePillContext {
  readonly view: FleetUpdateView;
  /**
   * The Overview's CLI-floor lane, the same flag the update card's park
   * sentence reads. See `cliFloorBlocked` in `host-overview-panel.tsx`.
   */
  readonly cliFloorBlocked: boolean;
}

/**
 * One row per update view kind, as a TABLE keyed by the kind: the construct
 * `LIVE_BADGE_WORD` and `RETAINED_BADGE_WORD` use in `host-option-model.ts`.
 * A new kind is then a missing key and a type error, not a silent gap. `null`
 * draws no pill.
 */
const LIVE_UPDATE_PILL: Record<
  FleetUpdateViewKind,
  ((context: UpdatePillContext) => HostOverviewUpdatePill) | null
> = {
  updating: () => ({ label: "Updating…", tone: "info" }),
  // A percentage only when the host measured one. "Downloading 0%" for an
  // unsized body would be a claim the host never made.
  downloading: ({ view }) => {
    const percent = operationProgressPercent(view);
    return {
      label: percent === null ? "Downloading…" : `Downloading ${percent}%`,
      tone: "info",
    };
  },
  preparing: () => ({ label: "Preparing…", tone: "info" }),
  applying: () => ({ label: "Installing…", tone: "info" }),
  verifying: () => ({ label: "Verifying…", tone: "info" }),
  "waiting-to-activate": () => ({
    label: "Restart to finish update",
    tone: "warning",
  }),
  // No count: the working chip beside the pill already carries it. The floor
  // wins over the work, as it does in the update card's sentence, because on a
  // floor-blocked host the work is not what the update is waiting for.
  "waiting-for-work": ({ cliFloorBlocked }) => ({
    label: cliFloorBlocked
      ? "Update waiting on CLI tools"
      : "Update waiting on work",
    tone: "warning",
  }),
  failed: () => ({ label: "Update failed", tone: "destructive" }),
  // Leaves with the success card; see `completionDismissed`.
  complete: ({ view }) => ({
    label:
      view.targetVersion === null
        ? "Updated"
        : `Updated to v${view.targetVersion}`,
    tone: "success",
  }),
  // The health word already reads "Restarting…".
  restarting: null,
  reconnecting: null,
  // Status explains each of these and points at Diagnostics, and the sidebar
  // picker shows no badge for them either.
  "finalizing-record": null,
  "verification-refused": null,
  unavailable: null,
  idle: null,
  // Reached through the retained arm below, never through this table.
  unknown: null,
};

/**
 * The pill for this update view, or `null` for none.
 *
 * A view the page can no longer vouch for gets the picker's retained words
 * instead: an `unknown` view with a retained phase, or a `qualified` one. The
 * live row would state a present tense ("Downloading 45%") that nobody can
 * currently confirm.
 */
export function deriveHostOverviewUpdatePill(input: {
  readonly view: FleetUpdateView | null;
  /**
   * Whether the header's health word reads "Restarting…". No pill at all
   * then, whatever the view says: the header already states it.
   */
  readonly restarting: boolean;
  /**
   * Whether the success acknowledgement for this attempt has run out or been
   * dismissed (`useHostUpdateCompletion`). "Updated to vX" leaves with it.
   */
  readonly completionDismissed: boolean;
  readonly cliFloorBlocked: boolean;
}): HostOverviewUpdatePill | null {
  const { view } = input;
  if (view === null || input.restarting) return null;
  if (view.kind === "unknown" || view.qualified) {
    const retainedKind =
      view.kind === "unknown" ? view.lastKnownKind : view.kind;
    if (retainedKind === null) return null;
    const word = retainedBadgeWord(retainedKind);
    return word === null
      ? null
      : { label: `Last seen: ${word}`, tone: "muted" };
  }
  if (view.kind === "complete" && input.completionDismissed) return null;
  const pill = LIVE_UPDATE_PILL[view.kind];
  return pill === null
    ? null
    : pill({ view, cliFloorBlocked: input.cliFloorBlocked });
}
