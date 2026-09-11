/**
 * What Auto chose, and what it measured to choose it.
 *
 * Auto picking a view is the one piece of office chrome that happens WITHOUT
 * the person asking, so it is also the one that owes them an explanation: a
 * floor that opens as a stack of cubbies reads as a bug until you know the
 * alternative was 0.43x. The chip is that sentence, and the picker's Auto row
 * carries the same numbers at more length.
 *
 * Placed by the renderer, like the picker and the mode toggle - this knows
 * what it says, not where it sits.
 */
import { cn } from "@/lib/utils";
import {
  officeZoomLabel,
  type OfficeAutoDecision,
  type OfficeAutoFit,
} from "@/lib/comm-graph/office/office-auto";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";

export interface OfficeAutoChipProps {
  /** `null` while the tile is still being measured. */
  readonly decision: OfficeAutoDecision | null;
}

/**
 * The candidate that came closest, where it is not the one Auto took - the
 * runner-up is the whole reason the chosen view was chosen.
 */
function runnerUpOf(decision: OfficeAutoDecision): OfficeAutoFit | null {
  let best: OfficeAutoFit | null = null;
  for (const fit of decision.fits) {
    if (fit.view === decision.view) continue;
    if (best === null || fit.zoom > best.zoom) best = fit;
  }
  return best;
}

function agentCountLabel(agents: number): string {
  return agents === 1 ? "1 agent" : `${agents} agents`;
}

function autoChipText(decision: OfficeAutoDecision): string {
  const runnerUp = runnerUpOf(decision);
  const measured = `Auto · ${OFFICE_VIEWS[decision.view].label} · measured at ${agentCountLabel(decision.agents)}`;
  if (runnerUp === null) return measured;
  return `${measured} · ${OFFICE_VIEWS[runnerUp.view].label} would be ${officeZoomLabel(runnerUp.zoom)}`;
}

export function OfficeAutoChip(props: OfficeAutoChipProps) {
  const { decision } = props;
  return (
    <div
      data-testid="comm-graph-office-auto-chip"
      className={cn(
        // Read-only: it must not take the pan or the click a person aims at
        // the floor underneath it.
        "pointer-events-none max-w-full truncate",
        "rounded-md border border-border bg-popover px-1.5 py-0.5",
        "text-ui-xs text-popover-foreground tabular-nums shadow-xs",
      )}
    >
      {decision === null ? "Auto · measuring…" : autoChipText(decision)}
    </div>
  );
}
