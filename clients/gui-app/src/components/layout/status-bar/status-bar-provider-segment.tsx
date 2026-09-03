import { Fragment, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import type { StatusBarDensity } from "@/components/layout/status-bar/status-bar-density";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { formatUnavailableReason } from "@/lib/provider-rate-limit-content";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
// The same glyph the strip's resource segment prints for a reading it does not
// have, so one bar never shows two different dashes for one idea.
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";
import { useResetCountdown } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { PercentMode } from "@/stores/settings/layout-store";

export interface StatusBarProviderSegmentProps {
  readonly segment: StatusBarProviderSegmentModel;
  readonly density: StatusBarDensity;
  readonly percentMode: PercentMode;
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
 * - **degraded** — the last good numbers, dimmed, behind a warning glyph whose
 *   tooltip names the failure. Showing them undimmed would date-stamp nothing;
 *   hiding them would throw away the only reading there is.
 */
export function StatusBarProviderSegment(
  props: StatusBarProviderSegmentProps,
): ReactNode {
  const segment = props.segment;
  const providerName = providerDisplayName(segment.providerId);
  const icon = (
    <HarnessIcon
      harnessId={providerIdToGuiHarnessId(segment.providerId)}
      className="size-3"
    />
  );
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1",
        segment.state === "degraded" && "opacity-60",
      )}
      data-testid={`status-bar-provider-segment-${segment.providerId}`}
      data-state={segment.state}
    >
      <TooltipWrapper
        label={tooltipFor(segment, providerName)}
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
              className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
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
 * `icon-only` is the icon and nothing else; `compact` keeps the tightest window
 * alone, which is the one a glance is for. Both drop the mini bar: at those
 * widths it is the first thing that stops being legible and the last thing that
 * carries information the text does not.
 */
function SegmentBody(props: StatusBarProviderSegmentProps): ReactNode {
  const { segment, density } = props;
  if (density === "icon-only") return null;
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
  const windows =
    density === "compact" && segment.tightest !== null
      ? [segment.tightest]
      : segment.windows;
  return (
    <>
      {props.showBar && density === "full" && segment.tightest !== null ? (
        <MiniBar window={segment.tightest} />
      ) : null}
      {windows.map((window, index) => (
        <Fragment key={window.windowKey}>
          {index === 0 ? null : (
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
          )}
          <StatusBarWindowText
            window={window}
            percentMode={props.percentMode}
            showTimer={props.showTimer}
          />
        </Fragment>
      ))}
    </>
  );
}

/**
 * The tightest visible window as a severity-coloured meter. A gauge rather than
 * a layout surface, so it is sized like the header glyph's bars are.
 */
function MiniBar(props: {
  readonly window: StatusBarRateLimitWindow;
}): ReactNode {
  return (
    <span
      aria-hidden
      data-testid="status-bar-provider-mini-bar"
      className="relative h-1 w-8 shrink-0 overflow-hidden rounded-[2px] bg-muted-foreground/35 dark:bg-muted-foreground/40"
    >
      <span
        data-testid="status-bar-provider-mini-bar-fill"
        className={cn(
          "absolute inset-y-0 left-0 rounded-[2px]",
          rateLimitWindowSeverityBarClassName(props.window.severity),
        )}
        style={{
          width: `${rateLimitWindowFillPercent(props.window.usedPercent)}%`,
        }}
      />
    </span>
  );
}

/**
 * One window, as `33% used 4h 15m`.
 *
 * A leaf of its own because the countdown subscribes to the shared 60s clock,
 * the idiom every other countdown in the app follows. It is not what keeps the
 * tick cheap here — the segments hook samples the same clock to expire windows,
 * so the cluster re-renders each minute either way — but it keeps this label
 * the only thing that has to, in every future where that stops being true.
 */
function StatusBarWindowText(props: {
  readonly window: StatusBarRateLimitWindow;
  readonly percentMode: PercentMode;
  readonly showTimer: boolean;
}): ReactNode {
  const { window } = props;
  // `null` when the timer is off, and also when the provider reported no reset
  // instant to count down to - both fall back to the catalog's static name.
  const countdown = useResetCountdown(props.showTimer ? window.resetsAt : null);
  return (
    <span
      className="whitespace-nowrap"
      data-testid={`status-bar-window-${window.windowKey}`}
    >
      {`${windowPercentText(window.usedPercent, props.percentMode)} ${windowLabel(window, countdown)}`}
    </span>
  );
}

/**
 * What follows the percentage.
 *
 * A countdown may only REPLACE a name that says nothing but how long the
 * window is, because that is the one case where it states the same fact more
 * precisely. Every other name — a model, a Cursor bucket, a named Codex limit,
 * a Grok billing period — is the only thing identifying WHICH limit the
 * percentage belongs to, and several of them are guaranteed to share one reset
 * instant with a sibling, so dropping the name would print two windows as one
 * indistinguishable string.
 */
function windowLabel(
  window: StatusBarRateLimitWindow,
  countdown: string | null,
): string {
  if (countdown === null) return window.label;
  return window.labelIsDuration ? countdown : `${window.label} ${countdown}`;
}

function tooltipFor(
  segment: StatusBarProviderSegmentModel,
  providerName: string,
): string {
  if (segment.state === "degraded") {
    return segment.reason === null
      ? `${providerName} · couldn't refresh usage, showing the last reading`
      : `${providerName} · ${formatUnavailableReason(segment.reason)} · showing the last reading`;
  }
  if (segment.state === "unavailable" && segment.reason !== null) {
    return `${providerName} · ${formatUnavailableReason(segment.reason)}`;
  }
  if (segment.state === "cold") return `${providerName} · no reading yet`;
  return providerName;
}
