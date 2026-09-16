/**
 * WHAT AUTO CHOSE, SAID OUT LOUD AND DRAWN NOWHERE.
 *
 * Auto picking a view is the one piece of office chrome that happens WITHOUT
 * the person asking, so it is also the one that owes them an explanation: a
 * floor that opens as a stack of cubbies reads as a bug until you know the
 * alternative was 0.43x.
 *
 * That explanation used to be a visible chip on the canvas, and feedback round
 * 1 asked for the chip to go - "the text at the bottom left is too verbose, is
 * it even needed?" - because the picker's own Auto row already carries the same
 * numbers at more length, one click away. What the chip ALSO carried, and what
 * a reader who cannot see the picker has no other route to, is the
 * announcement: its text changed with no gesture behind it, from
 * "Auto - measuring..." to the decided view, and `role="status"` +
 * `aria-live="polite"` is what turns that into something a screen reader says.
 *
 * So the sentence stays and the box goes. This renders `sr-only`: no border, no
 * background, no pixels on the canvas and no layout of its own - the visible
 * half of the chip is what the feedback was about, and none of it is here.
 *
 * `sr-only` rather than `hidden` or a bare string is the whole mechanism: a
 * live region has to be IN the accessibility tree and non-inert for a change
 * inside it to be announced, and `hidden` takes it out of both.
 */
import { cn } from "@/lib/utils";
import {
  officeZoomLabel,
  type OfficeAutoDecision,
  type OfficeAutoFit,
} from "@/lib/comm-graph/office/office-auto";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";

export interface OfficeAutoAnnouncerProps {
  /** This session's measurement, or `null` when none is in hand. */
  readonly decision: OfficeAutoDecision | null;
  /**
   * The outcome READ BACK from the tile, which outlives the measurement
   * behind it.
   *
   * Auto's answer is persisted; its arithmetic deliberately is not, so a tile
   * that comes back from a remount, a mode toggle or a restart knows which
   * office it settled on and nothing about how. That is a different state
   * from "no answer yet", and the announcer owes the reader a different
   * sentence: saying "measuring…" about a decision that was made and will not
   * be re-made is the one thing it must not do.
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

function measuredText(decision: OfficeAutoDecision): string {
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
 * no zoom - because the only honest thing this still knows is which office won.
 */
function restoredText(view: OfficeViewId): string {
  return `Auto · ${OFFICE_VIEWS[view].label} · measured earlier`;
}

function announcementText(
  decision: OfficeAutoDecision | null,
  restoredView: OfficeViewId | null,
): string {
  if (decision !== null) return measuredText(decision);
  if (restoredView !== null) return restoredText(restoredView);
  return "Auto · measuring…";
}

export function OfficeAutoAnnouncer(props: OfficeAutoAnnouncerProps) {
  const { decision, restoredView } = props;
  return (
    <span
      data-testid="comm-graph-office-auto-announcer"
      role="status"
      aria-live="polite"
      className={cn("sr-only")}
    >
      {announcementText(decision, restoredView)}
    </span>
  );
}
