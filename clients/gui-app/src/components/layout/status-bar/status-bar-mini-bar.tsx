import type { ReactNode } from "react";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
  type RateLimitWindowSeverity,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

/**
 * One rate-limit window as a severity-coloured meter. A gauge rather than a
 * layout surface, so it is sized like the header glyph's bars are.
 *
 * Its own module because two surfaces draw it: the strip's provider segment,
 * one per limit it shows, and Settings ▸ Layout's per-provider limit list, one
 * per limit it offers. A second drawing of the same three facts is how a bar in
 * the list ends up a shade or a pixel off the bar it is promising to be - and
 * the promise is the whole point of putting it in a control.
 *
 * `data-window-key` is what pairs a bar with the reading it belongs to for
 * anything reading the DOM: several bars sit on one segment (and one per row in
 * the list), and their ORDER is the only other thing tying them to their
 * numbers.
 *
 * The fields are passed flat rather than as a window object, so a caller that
 * holds its reading in some other shape - the Settings list holds catalog
 * entries, not segment models - does not have to build one to draw a bar.
 */
export function StatusBarMiniBar(props: {
  readonly windowKey: string;
  readonly usedPercent: number;
  readonly severity: RateLimitWindowSeverity;
}): ReactNode {
  return (
    <span
      aria-hidden
      data-testid="status-bar-provider-mini-bar"
      data-window-key={props.windowKey}
      className="relative h-1 w-8 shrink-0 overflow-hidden rounded-[2px] bg-muted-foreground/35 dark:bg-muted-foreground/40"
    >
      <span
        data-testid="status-bar-provider-mini-bar-fill"
        className={cn(
          "absolute inset-y-0 left-0 rounded-[2px]",
          rateLimitWindowSeverityBarClassName(props.severity),
        )}
        style={{ width: `${rateLimitWindowFillPercent(props.usedPercent)}%` }}
      />
    </span>
  );
}
