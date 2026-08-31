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
  // The host-reported percent is not range-validated on this path. Clamp
  // before it reaches ARIA (a valuenow outside min/max is an a11y contract
  // violation) or the inline width (a negative width is an invalid
  // declaration) — same clamp the banner's other progress readout applies.
  const clamped =
    props.percent === null ? null : Math.max(0, Math.min(100, props.percent));
  const determinate = clamped !== null;
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={clamped ?? undefined}
      className={cn(
        // `bg-foreground/8`, never `bg-muted`: this sits on a raised, tinted
        // banner surface, and every preset theme's dark variant collapses
        // `--muted` into the card/popover colour — the track would vanish.
        // Same track treatment as `local-host-loading`'s bar, deliberately.
        "h-1.5 w-full overflow-hidden rounded-full bg-foreground/8",
        props.className,
      )}
    >
      {clamped !== null ? (
        <div
          data-testid="update-progress-determinate"
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${String(clamped)}%` }}
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
