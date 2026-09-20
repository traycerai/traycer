import { Fragment, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import { StatusBarMiniBar } from "@/components/layout/status-bar/status-bar-mini-bar";
import {
  statusBarSegmentKey,
  statusBarSegmentTooltip,
  type StatusBarUsageParts,
} from "@/components/layout/status-bar/status-bar-usage-display";
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
  /** Which of the reading's optional parts the preferences switched on. */
  readonly parts: StatusBarUsageParts;
  readonly percentMode: PercentMode;
  /**
   * Whether this mount is the real strip rather than a passive preview (the
   * Settings page, or a Customize option's picture). Only an interactive
   * mount attaches the hotspot's `ref` - `useLayoutHotspot` still runs either
   * way (rules of hooks), but a `ref` nobody attaches never registers.
   */
  readonly interactive: boolean;
}

/**
 * One account's usage, at the detail the preferences ask for.
 *
 * Always the whole reading: the cluster this sits in scrolls when its
 * segments outgrow the strip, so nothing here is shortened to make room, and
 * the width of the window never changes what a segment says. What CAN vary is
 * what the user switched on - the mode word, the mini bar, the countdown -
 * which arrives as `parts`.
 *
 * A provider with several accounts checked draws one of these per account,
 * and what tells them apart is the profile's accent dot after the provider
 * icon and the account's NAME before the reading, so the strip reads
 * `Codex · Work 57% used 4h` beside `Codex · Personal 12% used 4h`. Neither is
 * drawn for a provider with fewer than two profiles, where there is nothing
 * to tell the one account apart from.
 *
 * Clicking a segment opens the usage panel on this provider with this
 * account's card in view. The segment itself is not a control - it sits inside
 * the cluster's `PopoverTrigger`, which is what opens the panel, so a nested
 * button would be both invalid markup and a second opener. Instead it names
 * itself in `data-provider-id` / `data-profile-id`, and the trigger's own
 * click handler reads which segment the click landed on
 * (`statusBarSegmentAtClick`).
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
function providerGhostCondition(
  segment: StatusBarProviderSegmentModel,
): string | null {
  if (segment.hidden) return "Hidden from the status bar";
  if (segment.state === "cold") return "No reading yet";
  if (segment.state === "unavailable" || segment.state === "degraded")
    return statusBarSegmentTooltip(segment);
  return null;
}

export function StatusBarProviderSegment(
  props: StatusBarProviderSegmentProps,
): ReactNode {
  const segment = props.segment;
  const ghost = segment.hidden || segment.state === "cold";
  const { ref, editing } = useLayoutHotspot({
    settingId: "statusBar.provider",
    tileId: statusBarSegmentKey(segment),
    ghost,
    condition: providerGhostCondition(segment),
  });
  const icon = (
    <HarnessIcon
      harnessId={providerIdToGuiHarnessId(segment.providerId)}
      className={cn("size-3", segment.state === "degraded" && "opacity-60")}
    />
  );
  return (
    <span
      ref={props.interactive ? ref : undefined}
      className={cn(
        "inline-flex min-w-0 items-center gap-1",
        props.interactive &&
          editing &&
          ghost &&
          "rounded-sm border border-dashed border-border/60 px-1 opacity-70",
      )}
      data-testid={`status-bar-provider-segment-${segment.providerId}`}
      data-provider-id={segment.providerId}
      data-profile-id={segment.profileId ?? ""}
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
          {segment.account === null ? null : (
            <span
              data-testid="status-bar-provider-account-dot"
              className="inline-flex shrink-0"
            >
              <AccentDot
                profileId={segment.account.profileId}
                accentColor={segment.account.accentColor}
                label={segment.account.label}
                variant="inline"
                size="compact"
                className={undefined}
              />
            </span>
          )}
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
 * The reading itself: the account's name where there is one, then one entry
 * per window the user selected (`segment.shown` - the tightest limit by
 * default, which is the one that decides whether the panel is worth opening),
 * each at the detail `parts` asks for.
 */
function SegmentBody(props: StatusBarProviderSegmentProps): ReactNode {
  const { segment, parts } = props;
  // The account's name before the reading rather than after, so `Work 57%`
  // and `Personal 12%` read as two labelled figures rather than one figure
  // with two trailing words.
  const accountName =
    segment.account === null ? null : (
      <span
        data-testid="status-bar-provider-account"
        className="whitespace-nowrap"
      >
        {segment.account.label}
      </span>
    );
  if (segment.state === "unavailable") {
    return (
      <>
        {accountName}
        <span aria-hidden="true" data-testid="status-bar-provider-unavailable">
          {UNAVAILABLE_DASH}
        </span>
      </>
    );
  }
  if (segment.state === "cold") {
    return (
      <>
        {accountName}
        <span
          data-testid="status-bar-provider-cold-track"
          aria-hidden="true"
          className="h-1 w-8 shrink-0 rounded-xs bg-muted-foreground/35 dark:bg-muted-foreground/40"
        />
      </>
    );
  }
  return (
    <>
      {accountName}
      {segment.shown.map((window, index) => (
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
            about. Gated as ONE decision for the whole segment, so the switch
            takes every bar away at once rather than thinning them. */}
          {parts.bar ? (
            <StatusBarMiniBar
              windowKey={window.windowKey}
              usedPercent={window.usedPercent}
              severity={window.severity}
            />
          ) : null}
          <StatusBarWindowText
            window={window}
            percentMode={props.percentMode}
            showModeWord={parts.modeWord}
            showTimer={parts.timer}
            // The provider's live windows, not the ones the selection draws:
            // a provider drawing its tightest alone still has to say which of
            // several that one is.
            visibleWindowCount={segment.windows.length}
          />
        </Fragment>
      ))}
    </>
  );
}

/**
 * One window, as `33% used 4h 15m` — or `33% 5h` with the mode word and the
 * countdown switched off.
 *
 * A leaf of its own because the countdown subscribes to the shared 60s clock,
 * the idiom every other countdown in the app follows. It is not what keeps the
 * tick cheap here — the segments hook samples the same clock to expire windows,
 * so the cluster re-renders each minute either way — but it keeps this label
 * the only thing that has to, in every future where that stops being true.
 *
 * The percentage is its own span, and the only tinted one. Severity is a fact
 * about the reading rather than a preference about it, so it survives every
 * switch — including the one that takes the mini bar away, which is the only
 * other place this colour appears.
 */
function StatusBarWindowText(props: {
  readonly window: StatusBarRateLimitWindow;
  readonly percentMode: PercentMode;
  readonly showModeWord: boolean;
  readonly showTimer: boolean;
  readonly visibleWindowCount: number;
}): ReactNode {
  const { window } = props;
  // `null` when the timer is off, and also when the provider reported no reset
  // instant to count down to - both fall back to the catalog's static name.
  const countdown = useResetCountdown(props.showTimer ? window.resetsAt : null);
  const suffix = [
    ...(props.showModeWord ? [props.percentMode] : []),
    windowLabelText({
      label: window.label,
      labelIsDuration: window.labelIsDuration,
      countdown,
      visibleWindowCount: props.visibleWindowCount,
    }),
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
      {` ${suffix}`}
    </span>
  );
}
