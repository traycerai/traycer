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
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";

export interface OfficeAutoChipProps {
  /** This session's measurement, or `null` when none is in hand. */
  readonly decision: OfficeAutoDecision | null;
  /**
   * The outcome READ BACK from the tile, which outlives the measurement
   * behind it.
   *
   * Auto's answer is persisted; its arithmetic deliberately is not, so a tile
   * that comes back from a remount, a mode toggle or a restart knows which
   * office it settled on and nothing about how. That is a different state
   * from "no answer yet", and the chip owes the reader a different sentence:
   * saying "measuring…" about a decision that was made and will not be
   * re-made is the one thing it must not do.
   */
  readonly restoredView: OfficeViewId | null;
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

/**
 * A winner with no measurement left to quote.
 *
 * "measured earlier" is doing two jobs: it accounts for the numbers that are
 * missing rather than leaving their absence to read as a bug, and it points at
 * the re-measure the picker's Auto row offers. It invents nothing - no count,
 * no zoom - because the only honest thing this chip still knows is which
 * office won.
 */
function restoredChipText(view: OfficeViewId): string {
  return `Auto · ${OFFICE_VIEWS[view].label} · measured earlier`;
}

function chipText(
  decision: OfficeAutoDecision | null,
  restoredView: OfficeViewId | null,
): string {
  if (decision !== null) return autoChipText(decision);
  if (restoredView !== null) return restoredChipText(restoredView);
  return "Auto · measuring…";
}

export function OfficeAutoChip(props: OfficeAutoChipProps) {
  const { decision, restoredView } = props;
  return (
    <div
      data-testid="comm-graph-office-auto-chip"
      // Its text changes with no gesture behind it - "Auto · measuring…"
      // becomes the decided view when the measurement lands - so the outcome
      // is announced rather than only drawn. The same `role="status"` +
      // `aria-live="polite"` pairing the settings surfaces use for passive
      // status text.
      role="status"
      aria-live="polite"
      className={cn(
        // Read-only: it must not take the pan or the click a person aims at
        // the floor underneath it.
        "pointer-events-none max-w-full truncate",
        "rounded-md border border-border bg-popover px-1.5 py-0.5",
        "text-ui-xs text-popover-foreground tabular-nums shadow-xs",
      )}
    >
      {chipText(decision, restoredView)}
    </div>
  );
}
