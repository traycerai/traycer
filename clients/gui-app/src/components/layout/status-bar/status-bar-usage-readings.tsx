import type { ReactNode } from "react";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import {
  statusBarSegmentKey,
  statusBarUsageParts,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import type { StatusBarRateLimitCluster } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";

/**
 * The readings themselves: every segment the cluster holds, each in full.
 *
 * Every one, because the box this renders into scrolls: a segment past the
 * strip's edge is a swipe away. What a segment prints is the preferences'
 * business alone (`statusBarUsageParts`), and it is the same at every width.
 *
 * Separate from the strip's trigger because the trigger is the part that is not
 * shared - it is a `PopoverTrigger`, and Radix throws for one outside a
 * `Popover`. What IS shared is everything a reader looks at, so the Settings
 * preview renders this exact component from the same display value and can
 * therefore never show a shape the strip cannot produce.
 */
export function StatusBarUsageReadings(props: {
  readonly cluster: StatusBarRateLimitCluster;
  readonly display: StatusBarUsageDisplay;
  /** `false` for every passive mount: the Settings preview, an option picture. */
  readonly interactive: boolean;
}): ReactNode {
  const { cluster, display, interactive } = props;
  const parts = statusBarUsageParts(display);
  return (
    <>
      {cluster.kind === "segments" ? (
        cluster.segments.map((segment) => (
          <StatusBarProviderSegment
            key={statusBarSegmentKey(segment)}
            segment={segment}
            parts={parts}
            percentMode={display.percentMode}
            interactive={interactive}
          />
        ))
      ) : (
        // One line, never wrapped: the box it sits in scrolls sideways, so a
        // sentence too long for a narrow strip scrolls like the segments do,
        // on the one row the strip has.
        <span className="whitespace-nowrap">
          {cluster.kind === "no-providers"
            ? // The popover's own zero state says this at length; the strip
              // says it once and opens that panel.
              "Connect a supported provider to see usage here."
            : "Usage hidden"}
        </span>
      )}
    </>
  );
}
