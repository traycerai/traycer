import { Fragment, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { StatusBarMiniBar } from "@/components/layout/status-bar/status-bar-mini-bar";
import { statusBarSegmentTooltip } from "@/components/layout/status-bar/status-bar-usage-display";
import {
  statusBarUsageDetailParts,
  type StatusBarUsageDetail,
} from "@/components/layout/status-bar/status-bar-usage-ladder";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import {
  rateLimitWindowSeverityTextClassName,
  RUNNING_LOW_TEXT_CLASS_NAME,
} from "@/lib/rate-limits/window-severity";
import {
  windowLabelText,
  windowPercentValueText,
} from "@/lib/rate-limits/status-bar-window-text";
// The same glyph the strip's resource segment prints for a reading it does not
// have, so one bar never shows two different dashes for one idea.
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";
import { useResetCountdown } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { PercentMode } from "@/stores/settings/layout-store";

export interface StatusBarProviderSegmentProps {
  readonly segment: StatusBarProviderSegmentModel;
  /** Which rung of the cluster's collapse ladder this is being drawn at. */
  readonly detail: StatusBarUsageDetail;
  readonly percentMode: PercentMode;
  readonly showModeWord: boolean;
  readonly showTimer: boolean;
  readonly showBar: boolean;
}

/**
 * One provider's usage, at whatever length the strip currently has room for.
 *
 * Three states have a shape rather than a number, and each is deliberately
 * distinguishable at a glance:
 *
 * - **cold** — the icon over an empty track. A reading that has not been taken
 *   is not a reading that is loading, so there is no spinner here and never
 *   was; the track says "this provider has a place in the bar" and nothing more.
 * - **unavailable** — the icon and a dash. The provider answered and said it
 *   cannot report usage, which is a fact about the account, not a blip.
 * - **degraded** — the last good numbers behind a dimmed provider icon and a
 *   warning glyph whose tooltip names the failure. Hiding them would throw
 *   away the only reading there is.
 *
 * The dim is on the ICON alone and never on the segment, which is a contrast
 * decision rather than a stylistic one. `rateLimitWindowSeverityTextClassName`
 * picks a per-tier shade for the sole purpose of clearing 4.5:1 on a light
 * canvas — amber goes as far as `700` for it — and `opacity` on an ancestor
 * composites that shade back down through the floor it was chosen to clear.
 * So what carries "this reading is stale" is the glyph and its sentence, which
 * cost the numbers nothing.
 */
export function StatusBarProviderSegment(
  props: StatusBarProviderSegmentProps,
): ReactNode {
  const segment = props.segment;
  const icon = (
    <HarnessIcon
      harnessId={providerIdToGuiHarnessId(segment.providerId)}
      className={cn("size-3", segment.state === "degraded" && "opacity-60")}
    />
  );
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      data-testid={`status-bar-provider-segment-${segment.providerId}`}
      data-state={segment.state}
    >
      <TooltipWrapper
        label={statusBarSegmentTooltip(segment)}
        side="top"
        sideOffset={6}
        align={undefined}
      >
        {/*
          No `sr-only` provider name in here: the trigger this sits inside
          carries an `aria-label`, which overrides its contents entirely, so a
          hidden name would be unreachable weight. The trigger's own name lists
          the providers instead.
        */}
        <span className="inline-flex items-center gap-1">
          {icon}
          {segment.state === "degraded" ? (
            <TriangleAlert
              // The same amber a `running_low` percentage prints, since one can
              // sit beside the other on this row.
              className={cn("size-3 shrink-0", RUNNING_LOW_TEXT_CLASS_NAME)}
              aria-hidden
              data-testid="status-bar-provider-degraded"
            />
          ) : null}
        </span>
      </TooltipWrapper>
      <SegmentBody {...props} />
    </span>
  );
}

/**
 * What survives at this rung.
 *
 * A preference that already switched something off is honoured on top of the
 * rung rather than instead of it: the ladder skips a rung that would take away
 * something invisible, and this AND-s the two so a rung reached from a
 * shorter ladder still cannot resurrect what Settings hid.
 *
 * The window list narrows for two different reasons, and only one of them is a
 * preference. The segment's `shown` list is the user's selection - the tightest
 * limit by default, which is the one that decides whether the panel is worth
 * opening. `percent-only` narrows to the tightest of those whatever the
 * selection says, because several bare percentages under one icon name which
 * limits exist without naming which is which.
 */
function SegmentBody(props: StatusBarProviderSegmentProps): ReactNode {
  const { segment } = props;
  const parts = statusBarUsageDetailParts(props.detail);
  if (!parts.percent) return null;
  if (segment.state === "unavailable") {
    return (
      <span aria-hidden="true" data-testid="status-bar-provider-unavailable">
        {UNAVAILABLE_DASH}
      </span>
    );
  }
  if (segment.state === "cold") {
    return (
      <span
        data-testid="status-bar-provider-cold-track"
        aria-hidden="true"
        className="h-1 w-8 shrink-0 rounded-[2px] bg-muted-foreground/35 dark:bg-muted-foreground/40"
      />
    );
  }
  const windows = windowsToDraw(segment, parts.label);
  // The rung and the preference have to agree before anything is drawn: a rung
  // cannot bring back what Settings hid, and a preference cannot keep what the
  // strip has run out of room for.
  const showModeWord = props.showModeWord && parts.modeWord;
  const showTimer = props.showTimer && parts.timer;
  const showBar = props.showBar && parts.bar;
  return (
    <>
      {windows.map((window, index) => (
        <Fragment key={window.windowKey}>
          {index === 0 ? null : (
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
          )}
          {/* One bar per reading, immediately before the number it measures.
            A provider showing several limits is showing several independent
            gauges, and a single bar in front of them would be a fourth
            severity colour with nothing on the row saying which limit it is
            about. Gated as ONE decision for the whole segment (`showBar`), so
            a rung that drops bars drops all of them at once rather than
            thinning them one at a time. */}
          {showBar ? (
            <StatusBarMiniBar
              windowKey={window.windowKey}
              usedPercent={window.usedPercent}
              severity={window.severity}
            />
          ) : null}
          <StatusBarWindowText
            window={window}
            percentMode={props.percentMode}
            showModeWord={showModeWord}
            showTimer={showTimer}
            showLabel={parts.label}
            // The provider's live windows, not the ones this rung draws: a
            // provider drawing its tightest alone still has to say which of
            // several that one is.
            visibleWindowCount={segment.windows.length}
          />
        </Fragment>
      ))}
    </>
  );
}

function windowsToDraw(
  segment: StatusBarProviderSegmentModel,
  labelled: boolean,
): ReadonlyArray<StatusBarRateLimitWindow> {
  if (labelled) return segment.shown;
  return segment.tightest === null ? [] : [segment.tightest];
}

/**
 * One window, as `33% used 4h 15m` — or as much of that as the rung allows,
 * down to `33%` alone.
 *
 * A leaf of its own because the countdown subscribes to the shared 60s clock,
 * the idiom every other countdown in the app follows. It is not what keeps the
 * tick cheap here — the segments hook samples the same clock to expire windows,
 * so the cluster re-renders each minute either way — but it keeps this label
 * the only thing that has to, in every future where that stops being true.
 *
 * The percentage is its own span, and the only tinted one. Severity is a fact
 * about the reading rather than about how much room the strip has, so it
 * survives every rung of the ladder — including the ones that took the mini bar
 * away, which is the only other place this colour appears.
 */
function StatusBarWindowText(props: {
  readonly window: StatusBarRateLimitWindow;
  readonly percentMode: PercentMode;
  readonly showModeWord: boolean;
  readonly showTimer: boolean;
  readonly showLabel: boolean;
  readonly visibleWindowCount: number;
}): ReactNode {
  const { window } = props;
  // `null` when the timer is off, and also when the provider reported no reset
  // instant to count down to - both fall back to the catalog's static name.
  const countdown = useResetCountdown(props.showTimer ? window.resetsAt : null);
  const suffix = [
    ...(props.showModeWord ? [props.percentMode] : []),
    ...(props.showLabel
      ? [
          windowLabelText({
            label: window.label,
            labelIsDuration: window.labelIsDuration,
            countdown,
            visibleWindowCount: props.visibleWindowCount,
          }),
        ]
      : []),
  ].join(" ");
  return (
    <span
      className="whitespace-nowrap"
      data-testid={`status-bar-window-${window.windowKey}`}
    >
      <span
        data-testid={`status-bar-window-percent-${window.windowKey}`}
        className={rateLimitWindowSeverityTextClassName(window.severity)}
      >
        {windowPercentValueText(window.usedPercent, props.percentMode)}
      </span>
      {suffix === "" ? null : ` ${suffix}`}
    </span>
  );
}
