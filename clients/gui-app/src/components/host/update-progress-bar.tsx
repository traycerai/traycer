import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A zero-width determinate bar and an unmeasured one are indistinguishable on screen for the first instant and
 * then diverge into a claim the host never made. */
export function UpdateProgressBar(props: {
  readonly percent: number | null;
  readonly label: string;
  readonly className: string | undefined;
}): ReactNode {
  // Clamp before it reaches ARIA (a valuenow outside min/max is an a11y contract violation) or the inline width
  // (a negative width is an invalid declaration) - same clamp the banner's other progress readout applies.
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
        // `bg-foreground/8`, never `bg-muted`: this sits on a raised, tinted banner surface, and every preset theme's
        // dark variant collapses `--muted` into the card/popover colour - the track would vanish.
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
        // Reuses the existing `host-progress-indeterminate` keyframe from `index.css` rather than adding a second one:
        // one indeterminate motion in the app means a person learns it once.
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
