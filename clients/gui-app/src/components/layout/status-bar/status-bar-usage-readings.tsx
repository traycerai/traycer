import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import {
  statusBarClusterSegments,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import type { StatusBarUsageStop } from "@/components/layout/status-bar/status-bar-usage-ladder";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { providerDisplayName } from "@/lib/provider-ordering";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import type { PercentMode } from "@/stores/settings/layout-store";

/**
 * The readings themselves: every provider the cluster is showing, plus the
 * `+N` chip for the ones it ran out of room for.
 *
 * Separate from the strip's trigger because the trigger is the part that is not
 * shared - it is a `PopoverTrigger`, and Radix throws for one outside a
 * `Popover`. What IS shared is everything a reader looks at, so the Settings
 * preview renders this exact component at the same rung and can therefore never
 * show a shape the strip cannot produce.
 *
 * The measured box stays at the CALL SITE rather than being handed a ref: the
 * ladder observes two boxes, the container and the content, and a component
 * that took one of them would leave the pair split across two files for no
 * gain.
 */
export function StatusBarUsageReadings(props: {
  readonly cluster: StatusBarRateLimitCluster;
  readonly stop: StatusBarUsageStop;
  readonly display: StatusBarUsageDisplay;
}): ReactNode {
  const { cluster, stop, display } = props;
  const segments = statusBarClusterSegments(cluster);
  const shownCount = segments.length - stop.foldedCount;
  return (
    <>
      {cluster.kind === "segments" ? (
        <>
          {segments.slice(0, shownCount).map((segment) => (
            <StatusBarProviderSegment
              key={segment.providerId}
              segment={segment}
              detail={stop.detail}
              expanded={display.expandedProviders.includes(segment.providerId)}
              percentMode={display.percentMode}
              showModeWord={display.showModeWord}
              showTimer={display.showTimer}
              showBar={display.showBar}
            />
          ))}
          {stop.foldedCount === 0 ? null : (
            <FoldedProvidersChip
              segments={segments.slice(shownCount)}
              percentMode={display.percentMode}
            />
          )}
        </>
      ) : (
        <span className="truncate">
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

/**
 * The providers the strip ran out of room for, as one chip.
 *
 * Folding from the right rather than dropping: the last thing a strip should do
 * with a limit it cannot fit is pretend the provider is not configured. The
 * chip sits inside the trigger, so clicking it opens the panel that lists every
 * one of them in full — the tooltip is the glance, the panel is the answer.
 *
 * A provider with no reading yet is named without one. `+2` promising two
 * numbers and delivering one would be a worse chip than one that says which
 * providers are behind it.
 */
function FoldedProvidersChip(props: {
  readonly segments: ReadonlyArray<StatusBarProviderSegmentModel>;
  readonly percentMode: PercentMode;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="status-bar-folded-providers"
          className="shrink-0 rounded-[3px] border border-border/70 px-1 leading-none"
        >
          {`+${props.segments.length}`}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <span className="flex flex-col">
          {props.segments.map((segment) => (
            <span key={segment.providerId}>
              {providerReadingText(segment, props.percentMode)}
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** One provider and its tightest reading, or the provider alone when it has none. */
function providerReadingText(
  segment: StatusBarProviderSegmentModel,
  percentMode: PercentMode,
): string {
  const name = providerDisplayName(segment.providerId);
  if (segment.tightest === null) return name;
  return `${name} ${windowPercentText(segment.tightest.usedPercent, percentMode)}`;
}
