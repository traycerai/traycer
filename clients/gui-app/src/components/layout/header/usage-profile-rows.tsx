import type { ReactNode } from "react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import { StatusBarMiniBar } from "@/components/layout/status-bar/status-bar-mini-bar";
import {
  statusBarClusterSegments,
  statusBarSegmentKey,
  statusBarSegmentSeverity,
  statusBarSegmentTooltip,
  useStatusBarUsageDisplay,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { windowPercentValueText } from "@/lib/rate-limits/status-bar-window-text";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
  rateLimitWindowSeverityTextClassName,
} from "@/lib/rate-limits/window-severity";
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";
import { useResetCountdown } from "@/lib/relative-time";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/** The most profiles the top strip's Detailed reading draws, so it cannot push the tabs out. */
const TOP_STRIP_PROFILE_CAP = 2;

/**
 * The profiles the top strip's Detailed reading draws: the most-used ones, up to
 * the cap, kept in the user's profile order (severity never moves an item), and
 * how many more there are.
 */
function topStripProfiles(cluster: StatusBarRateLimitCluster): {
  readonly drawn: ReadonlyArray<StatusBarProviderSegmentModel>;
  readonly more: number;
} {
  const segments = statusBarClusterSegments(cluster);
  const mostUsed = new Set(
    [...segments]
      .sort(
        (a, b) =>
          (b.tightest?.usedPercent ?? -1) - (a.tightest?.usedPercent ?? -1),
      )
      .slice(0, TOP_STRIP_PROFILE_CAP),
  );
  return {
    drawn: segments.filter((segment) => mostUsed.has(segment)),
    more: Math.max(0, segments.length - TOP_STRIP_PROFILE_CAP),
  };
}

/** One profile's facts, worded once for both Detailed forms. */
function useProfileReading(
  segment: StatusBarProviderSegmentModel,
  display: StatusBarUsageDisplay,
): {
  readonly value: string;
  readonly reset: string | null;
  readonly valueClassName: string;
} {
  const window = segment.tightest;
  const countdown = useResetCountdown(
    display.showTimer && window !== null ? window.resetsAt : null,
  );
  if (window === null || segment.state === "unavailable") {
    return {
      value: UNAVAILABLE_DASH,
      reset: null,
      valueClassName: "text-muted-foreground",
    };
  }
  const severity = statusBarSegmentSeverity(segment);
  const limited = severity === "limited";
  const reset =
    limited && countdown !== null ? `resets ${countdown}` : countdown;
  return {
    value: limited
      ? "Limit"
      : windowPercentValueText(window.usedPercent, display.percentMode),
    reset,
    valueClassName: rateLimitWindowSeverityTextClassName(severity),
  };
}

function ProfileMark(props: {
  readonly segment: StatusBarProviderSegmentModel;
}): ReactNode {
  const { segment } = props;
  return (
    <>
      <HarnessIcon
        harnessId={providerIdToGuiHarnessId(segment.providerId)}
        className={cn("size-3", segment.state === "degraded" && "opacity-60")}
      />
      {segment.account === null ? null : (
        <AccentDot
          profileId={segment.account.profileId}
          accentColor={segment.account.accentColor}
          label={segment.account.label}
          variant="inline"
          size="compact"
          className={undefined}
        />
      )}
    </>
  );
}

function ProfileTooltip(props: {
  readonly segment: StatusBarProviderSegmentModel;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TooltipWrapper
      label={statusBarSegmentTooltip(props.segment)}
      side="bottom"
      sideOffset={6}
      align={undefined}
    >
      {props.children}
    </TooltipWrapper>
  );
}

function profileName(segment: StatusBarProviderSegmentModel): string {
  return segment.account?.label ?? providerDisplayName(segment.providerId);
}

/**
 * The top strip's Detailed usage: at most the two most-used profiles, each as
 * logo, dot, name, bar, value and reset time, then "+N" for the rest. Capped,
 * so it never grows past that and never squeezes the tabs.
 */
export function TopStripUsageRows(props: {
  readonly cluster: StatusBarRateLimitCluster;
}): ReactNode {
  const display = useStatusBarUsageDisplay();
  const { drawn, more } = topStripProfiles(props.cluster);
  return (
    <span
      aria-hidden
      data-testid="top-strip-usage-rows"
      className="flex min-w-0 items-center gap-3 text-ui-xs"
    >
      {drawn.map((segment) => (
        <TopStripProfile
          key={statusBarSegmentKey(segment)}
          segment={segment}
          display={display}
        />
      ))}
      {more > 0 ? (
        <span
          data-testid="top-strip-usage-more"
          className="text-muted-foreground"
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}

function TopStripProfile(props: {
  readonly segment: StatusBarProviderSegmentModel;
  readonly display: StatusBarUsageDisplay;
}): ReactNode {
  const { segment, display } = props;
  const reading = useProfileReading(segment, display);
  return (
    <ProfileTooltip segment={segment}>
      <span
        data-testid={`usage-profile-${statusBarSegmentKey(segment)}`}
        className="inline-flex items-center gap-1 whitespace-nowrap"
      >
        <ProfileMark segment={segment} />
        <span>{profileName(segment)}</span>
        <StatusBarMiniBar
          windowKey={segment.tightest?.windowKey ?? ""}
          size="expanded"
          usedPercent={segment.tightest?.usedPercent ?? 0}
          severity={statusBarSegmentSeverity(segment)}
        />
        <span className={reading.valueClassName}>{reading.value}</span>
        {reading.reset === null ? null : (
          <span className="text-muted-foreground">{reading.reset}</span>
        )}
      </span>
    </ProfileTooltip>
  );
}

/**
 * The side strip's Detailed usage: one row per profile in profile order (logo,
 * dot, name, value, reset), each over a 3px full-width bar.
 */
export function SideStripUsageRows(props: {
  readonly cluster: StatusBarRateLimitCluster;
}): ReactNode {
  const display = useStatusBarUsageDisplay();
  return (
    <span
      aria-hidden
      data-testid="side-strip-usage-rows"
      className="flex w-full min-w-0 flex-col gap-2 text-ui-xs"
    >
      {statusBarClusterSegments(props.cluster).map((segment) => (
        <SideStripProfile
          key={statusBarSegmentKey(segment)}
          segment={segment}
          display={display}
        />
      ))}
    </span>
  );
}

function SideStripProfile(props: {
  readonly segment: StatusBarProviderSegmentModel;
  readonly display: StatusBarUsageDisplay;
}): ReactNode {
  const { segment, display } = props;
  const reading = useProfileReading(segment, display);
  return (
    <ProfileTooltip segment={segment}>
      <span
        data-testid={`usage-profile-${statusBarSegmentKey(segment)}`}
        className="flex min-w-0 flex-col gap-1"
      >
        <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
          <ProfileMark segment={segment} />
          <span className="min-w-0 flex-1 truncate text-start">
            {profileName(segment)}
          </span>
          <span className={reading.valueClassName}>{reading.value}</span>
          {reading.reset === null ? null : (
            <span className="text-muted-foreground">{reading.reset}</span>
          )}
        </span>
        <span
          aria-hidden
          data-testid="side-strip-usage-bar"
          className="relative h-0.75 w-full overflow-hidden rounded-xs bg-muted-foreground/35 dark:bg-muted-foreground/40"
        >
          {segment.tightest === null ? null : (
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-xs",
                rateLimitWindowSeverityBarClassName(
                  statusBarSegmentSeverity(segment),
                ),
              )}
              style={{
                width: `${rateLimitWindowFillPercent(segment.tightest.usedPercent)}%`,
              }}
            />
          )}
        </span>
      </span>
    </ProfileTooltip>
  );
}
