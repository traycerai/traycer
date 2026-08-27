import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The update operation's progress indicator, shared by the landing banner and
 * the selected-host Overview so a measured percentage looks the same wherever
 * it is shown.
 *
 * DETERMINATE vs INDETERMINATE is a real distinction here, not a styling one.
 * The experience doc requires that a percentage appear only when the host
 * actually measured one and that every other phase be *explicitly*
 * indeterminate — so `percent: null` renders a moving track with no
 * `aria-valuenow`, never a bar parked at zero. A zero-width determinate bar and
 * an unmeasured one are indistinguishable on screen for the first instant and
 * then diverge into a claim the host never made.
 *
 * `role="progressbar"` in both cases: assistive technology should know work is
 * in flight even when its size is unknown, which is exactly what a progressbar
 * with no value communicates.
 */
export function UpdateProgressBar(props: {
  /** `null` renders indeterminate. Callers pass `operationProgressPercent`. */
  readonly percent: number | null;
  /** Names what is progressing — host and phase — for screen readers. */
  readonly label: string;
  readonly className: string | undefined;
}): ReactNode {
  const determinate = props.percent !== null;
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={props.percent ?? undefined}
      className={cn(
        // `bg-foreground/8`, never `bg-muted`: this sits on a raised, tinted
        // banner surface, and every preset theme's dark variant collapses
        // `--muted` into the card/popover colour — the track would vanish.
        // Same track treatment as `local-host-loading`'s bar, deliberately.
        "h-1.5 w-full overflow-hidden rounded-full bg-foreground/8",
        props.className,
      )}
    >
      {determinate ? (
        <div
          data-testid="update-progress-determinate"
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${String(props.percent)}%` }}
        />
      ) : (
        // A SWEEPING SEGMENT, not a pulsing full-width fill — a full bar reads
        // as finished however it is animated. Reuses the existing
        // `host-progress-indeterminate` keyframe from `index.css` rather than
        // adding a second one: one indeterminate motion in the app means a
        // person learns it once. `animation` inline because that keyframe is
        // app CSS and has no utility.
        <div
          data-testid="update-progress-indeterminate"
          className="h-full w-2/5 rounded-full bg-primary"
          style={{
            animation: "host-progress-indeterminate 1.4s ease-in-out infinite",
          }}
        />
      )}
    </div>
  );
}
