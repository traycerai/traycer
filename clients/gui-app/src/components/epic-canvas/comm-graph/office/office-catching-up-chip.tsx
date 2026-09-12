/**
 * THE FEED IS BEHIND, and this office was drawn without waiting for it.
 *
 * The office is a drawing of the agent list, so it opens as soon as that list
 * and a box exist - it does not wait for the event feed to replay. What the
 * feed carries is who is BUSY, which means that until it catches up the floor
 * is honest about who is in the building and provisional about what they are
 * doing: desks are filled, statuses are the ones the epic already knew, and
 * the pips settle as the replay lands.
 *
 * That is a real difference from the office a moment later, and nothing else
 * on the floor shows it - a room of idle characters looks exactly like a room
 * of idle characters - so it is said in a line instead. NOT a spinner over the
 * canvas: there is nothing to wait for, the office is already drawn, and a
 * spinner would make an available office look like a loading one.
 *
 * Placed by the renderer beside the LOD chip, like every other chip here:
 * this knows what it says, not where it sits.
 *
 * WHETHER it says anything is its own call rather than the renderer's, which
 * is the one thing here that is not the house style: the canvas component is
 * at its complexity ceiling, and a condition spent on a chip is a condition
 * not spent on the frame loop. The two facts it needs are props, so the
 * decision is as visible at the call site as a ternary would have been.
 */
import { cn } from "@/lib/utils";

export interface OfficeCatchingUpChipProps {
  /**
   * Whether an office is actually on screen - the canvas's own `ready`. While
   * Auto is still measuring there is no office to be behind on, and its chip
   * says `measuring…` instead.
   */
  readonly officeDrawn: boolean;
  /** Whether every initial history source has handed over its backlog. */
  readonly initialHistoryCaughtUp: boolean;
}

export function OfficeCatchingUpChip(props: OfficeCatchingUpChipProps) {
  if (!props.officeDrawn) return null;
  if (props.initialHistoryCaughtUp) return null;
  return (
    <div
      data-testid="comm-graph-office-catching-up-chip"
      // It appears and goes with no gesture behind it, so it is announced
      // rather than only drawn - the same `role="status"` + `aria-live`
      // pairing the auto chip beside it uses.
      role="status"
      aria-live="polite"
      className={cn(
        // Read-only, like the chips above and below it: it must not take the
        // pan or the click a person aims at the floor underneath it.
        "pointer-events-none max-w-full truncate",
        "rounded-md border border-border bg-popover px-1.5 py-0.5",
        "text-ui-xs text-muted-foreground shadow-xs",
      )}
    >
      Catching up… · statuses may lag
    </div>
  );
}
