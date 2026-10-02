import { Fragment, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import { StatusBarMiniBar } from "@/components/layout/status-bar/status-bar-mini-bar";
import {
  statusBarSegmentSeverity,
  statusBarSegmentTooltip,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import {
  rateLimitWindowSeverityTextClassName,
  RUNNING_LOW_TEXT_CLASS_NAME,
} from "@/lib/rate-limits/window-severity";
import {
  windowLabelText,
  windowPercentText,
  windowPercentValueText,
} from "@/lib/rate-limits/status-bar-window-text";
// The same glyph the strip's resource segment prints for a reading it does not
// have, so one bar never shows two different dashes for one idea.
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";
import { formatResetCountdown, useSampledNow } from "@/lib/relative-time";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";

/**
 * The reading's arrival, at the same 140ms the leader badge and the dock's
 * pills use. `0.97` rather than a pop: a status-bar reading is peripheral, and
 * what it has to bridge is the jump from a blank track to a number.
 *
 * There is deliberately no exit. The `TabStripDropIndicator` argument applies
 * here too - an exiting reading would keep the old one in the row while the
 * new one enters, and a strip that scrolls would briefly show two.
 */
const READING_ARRIVAL = { opacity: 0, scale: 0.97 } as const;
const READING_PRESENT = { opacity: 1, scale: 1 } as const;
const READING_TRANSITION = { duration: 0.14, ease: "easeOut" } as const;

/**
 * The severity tone crossing a threshold. Longer than the arrival because a
 * colour crossfade at 140ms reads as a flicker rather than as a change, and
 * still inside the family's ceiling for a UI response.
 */
const SEVERITY_TRANSITION_CLASS_NAME =
  "transition-colors duration-200 ease-out";

export interface StatusBarProviderSegmentProps {
  readonly segment: StatusBarProviderSegmentModel;
  readonly display: StatusBarUsageDisplay;
}

/**
 * One account's usage, in the form its severity earns (see `SegmentBody`):
 * calm is a logo, dot and bar; running low and limited expand in place.
 *
 * Nothing here is shortened to make room: the cluster this sits in scrolls
 * when its segments outgrow the strip - except the account NAME on a phone,
 * which truncates to a floor first. The form never changes with the width of
 * the window. What the user chose arrives as `display`: Used or Remaining, and
 * whether an expanded profile prints its reset time.
 *
 * A provider with several accounts checked draws one of these per account,
 * and what tells them apart is the profile's accent dot after the provider
 * icon and the account's NAME before the reading, so the strip reads
 * `Codex Work [bar] 86% 5d` beside a bare `Codex [bar]`. Neither is drawn
 * for a provider with fewer than two profiles, where there is nothing to tell
 * the one account apart from.
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
export function StatusBarProviderSegment(
  props: StatusBarProviderSegmentProps,
): ReactNode {
  const { segment, display } = props;
  const now = useSampledNow();
  const hasNumbers = segment.state === "live" || segment.state === "degraded";
  const icon = (
    <HarnessIcon
      harnessId={providerIdToGuiHarnessId(segment.providerId)}
      className={cn("size-3", segment.state === "degraded" && "opacity-60")}
    />
  );
  const identity = (
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
  );
  return (
    <span
      // `min-w-min` on a phone, where the strip's row can shrink: the
      // segment gives no further than its readings' floor, so a squeezed
      // strip scrolls instead of drawing one segment over the next.
      className="inline-flex min-w-0 items-center gap-1 max-md:min-w-min"
      data-testid={`status-bar-provider-segment-${segment.providerId}`}
      data-provider-id={segment.providerId}
      data-profile-id={segment.profileId ?? ""}
      data-state={segment.state}
    >
      {/*
        One tooltip over the whole segment, in one place for every state: a
        calm profile has no text of its own, so this is where its numbers are,
        and a tree that changed shape between states would remount the reading
        (and with it the arrival animation a cold provider's first report
        needs).

        No `sr-only` provider name in here: the trigger this sits inside
        carries an `aria-label`, which overrides its contents entirely, so a
        hidden name would be unreachable weight. The trigger's own name lists
        the providers instead.
      */}
      <TooltipWrapper
        label={
          hasNumbers
            ? segmentNumbersTooltip(segment, display, now)
            : statusBarSegmentTooltip(segment)
        }
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <span
          data-testid="status-bar-provider-tooltip-target"
          className="inline-flex items-center gap-1"
        >
          {identity}
          <SegmentBody segment={segment} display={display} now={now} />
        </span>
      </TooltipWrapper>
    </span>
  );
}

/**
 * The reading itself, in the form the profile's severity earns.
 *
 * **Calm** (`healthy`): what the Reading style draws - the 16px bar by default,
 * or the percentage, or both. The rest is one hover away (the tooltip wraps the
 * whole segment) and one click away (the panel).
 * **Expanded** (`running_low`, `limited`, or every profile under Everything):
 * the profile's name, then per window a 32px bar, the percentage - or "Limit" -
 * and the reset time. The segment grows where it stands: the form depends on
 * severity and the chosen style alone, never on position.
 *
 * The form is decided per segment, from the worst of its shown windows
 * (`statusBarSegmentSeverity`). Inside an expanded segment each window still
 * prints its own tier, so a healthy window beside a limited one reads as a
 * percentage and not as "Limit".
 */
function SegmentBody(props: {
  readonly segment: StatusBarProviderSegmentModel;
  readonly display: StatusBarUsageDisplay;
  readonly now: number;
}): ReactNode {
  const { segment, display, now } = props;
  const motionEnabled = useMotionEnabled();
  const isCold = segment.state === "cold";
  const expanded =
    display.readingStyle === "full" ||
    statusBarSegmentSeverity(segment) !== "healthy";
  // The account's name before the reading rather than after, so `Work 57%`
  // and `Personal 12%` read as two labelled figures rather than one figure
  // with two trailing words. A profile with no account tells nothing apart, so
  // its name is the provider's.
  //
  // On a phone the name is the one part of the strip that gives when the
  // readings outgrow it: it truncates down to a `5ch` floor before the strip
  // falls back to scrolling. A one-track grid is what sets that floor as the
  // name's MIN-CONTENT width - a plain truncating span still contributes its
  // whole text to every ancestor's minimum, so nothing above it could shrink.
  const name = expanded ? (
    <span
      data-testid={
        segment.account === null
          ? "status-bar-provider-name"
          : "status-bar-provider-account"
      }
      className="whitespace-nowrap text-foreground max-md:inline-grid max-md:grid-cols-[minmax(5ch,max-content)]"
    >
      <span className="min-w-0 truncate">
        {segment.account === null
          ? providerDisplayName(segment.providerId)
          : segment.account.label}
      </span>
    </span>
  ) : null;
  return (
    <>
      {name}
      {/*
        The track and the reading are siblings rather than two keyed members of
        the presence below, and that is the point: the track leaves in the same
        commit the reading arrives in, so the row never holds both and never
        holds neither. `AnimatePresence initial={false}` then means exactly the
        thing wanted - a segment already reporting when the bar first paints
        does not animate, and a segment that has been sitting on its track
        since startup animates the moment its provider first answers.
      */}
      {isCold ? (
        <span
          data-testid="status-bar-provider-cold-track"
          aria-hidden="true"
          className="h-1 w-4 shrink-0 rounded-xs bg-muted-foreground/35 dark:bg-muted-foreground/40"
        />
      ) : null}
      <AnimatePresence initial={false}>
        {isCold ? null : (
          <m.span
            key="reading"
            data-testid="status-bar-provider-reading"
            // The same row the reading's parts were direct members of, with
            // the same gap - and deliberately no `min-w-0`: a flex item's
            // `min-width: auto` is what keeps a reading at full width in a
            // strip that scrolls rather than shortens, and the members had it
            // before this box existed.
            className="inline-flex items-center gap-1"
            initial={motionEnabled ? READING_ARRIVAL : false}
            animate={READING_PRESENT}
            transition={READING_TRANSITION}
          >
            {segment.state === "unavailable" ? (
              <span
                aria-hidden="true"
                data-testid="status-bar-provider-unavailable"
              >
                {UNAVAILABLE_DASH}
              </span>
            ) : (
              segment.shown.map((window, index) => (
                <Fragment key={window.windowKey}>
                  {index === 0 ? null : (
                    <span aria-hidden className="text-muted-foreground/60">
                      ·
                    </span>
                  )}
                  {expanded ? (
                    <StatusBarExpandedWindow
                      window={window}
                      display={display}
                      now={now}
                      // The provider's live windows, not the ones the selection
                      // draws: a provider drawing its tightest alone still has
                      // to say which of several that one is.
                      liveWindowCount={segment.windows.length}
                      motionEnabled={motionEnabled}
                    />
                  ) : (
                    <StatusBarCalmWindow
                      window={window}
                      display={display}
                      motionEnabled={motionEnabled}
                    />
                  )}
                </Fragment>
              ))
            )}
          </m.span>
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * One window of a calm profile, drawn as the Reading style says: the 16px bar,
 * the percentage, or the bar then the percentage. A calm window is `healthy`,
 * so its percentage is never "Limit".
 */
function StatusBarCalmWindow(props: {
  readonly window: StatusBarRateLimitWindow;
  readonly display: StatusBarUsageDisplay;
  readonly motionEnabled: boolean;
}): ReactNode {
  const { window, display } = props;
  return (
    <>
      {display.readingStyle === "percent" ? null : (
        <StatusBarMiniBar
          windowKey={window.windowKey}
          size="calm"
          usedPercent={window.usedPercent}
          severity={window.severity}
        />
      )}
      {display.readingStyle === "bar" ? null : (
        <StatusBarWindowPercent
          window={window}
          display={display}
          motionEnabled={props.motionEnabled}
        />
      )}
    </>
  );
}

/**
 * A window's percentage, or "Limit" once the host says it is `limited`.
 *
 * It is the only tinted span - severity is a fact about the reading rather
 * than a preference about it, so the tone crossing a threshold is bridged and
 * the digits do not roll.
 */
function StatusBarWindowPercent(props: {
  readonly window: StatusBarRateLimitWindow;
  readonly display: StatusBarUsageDisplay;
  readonly motionEnabled: boolean;
}): ReactNode {
  const { window } = props;
  const severityClassName = props.motionEnabled
    ? cn(
        rateLimitWindowSeverityTextClassName(window.severity),
        SEVERITY_TRANSITION_CLASS_NAME,
      )
    : rateLimitWindowSeverityTextClassName(window.severity);
  return (
    <span
      data-testid={`status-bar-window-percent-${window.windowKey}`}
      className={cn("font-medium", severityClassName)}
    >
      {window.severity === "limited"
        ? "Limit"
        : windowPercentValueText(window.usedPercent, props.display.percentMode)}
    </span>
  );
}

/**
 * One window of an expanded profile: `[32px bar] 86% 5d`, or `[bar] Limit
 * resets 3d` once the host says it is `limited`. Under Everything the percent
 * carries its "used" or "remaining" word: `[bar] 86% used 5d`. Under Percent
 * there is no bar at all: expanding only adds the name, value and reset time.
 *
 * What follows the percentage is `windowLabelText`'s: the countdown, the
 * window's name, or both, so with Reset time off the countdown gives way to the
 * name.
 */
function StatusBarExpandedWindow(props: {
  readonly window: StatusBarRateLimitWindow;
  readonly display: StatusBarUsageDisplay;
  readonly now: number;
  readonly liveWindowCount: number;
  /** Resolved once per segment, not once per window. */
  readonly motionEnabled: boolean;
}): ReactNode {
  const { window, display } = props;
  const limited = window.severity === "limited";
  const countdown =
    display.showTimer && window.resetsAt !== null
      ? formatResetCountdown(window.resetsAt, props.now)
      : null;
  const label = windowLabelText({
    label: window.label,
    labelIsDuration: window.labelIsDuration,
    countdown:
      countdown !== null && limited ? `resets ${countdown}` : countdown,
    visibleWindowCount: props.liveWindowCount,
  });
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap"
      data-testid={`status-bar-window-${window.windowKey}`}
    >
      {display.readingStyle === "percent" ? null : (
        <StatusBarMiniBar
          windowKey={window.windowKey}
          size="expanded"
          usedPercent={window.usedPercent}
          severity={window.severity}
        />
      )}
      <StatusBarWindowPercent
        window={window}
        display={display}
        motionEnabled={props.motionEnabled}
      />
      {display.readingStyle === "full" && !limited ? (
        <span>{display.percentMode}</span>
      ) : null}
      <span>{label}</span>
    </span>
  );
}

/**
 * What a profile with a reading says on hover: `personal · 41% used · resets
 * in 5d`. Several shown windows read as one clause each, split by `;`.
 */
function segmentNumbersTooltip(
  segment: StatusBarProviderSegmentModel,
  display: StatusBarUsageDisplay,
  now: number,
): string {
  const name =
    segment.account === null
      ? providerDisplayName(segment.providerId)
      : segment.account.label;
  const clauses = segment.shown.map((window) =>
    [
      segment.windows.length > 1 ? window.label : null,
      windowPercentText(window.usedPercent, display.percentMode),
      window.resetsAt === null
        ? null
        : `resets in ${formatResetCountdown(window.resetsAt, now)}`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
  );
  // A degraded reading still has to say why it is stale, ahead of the numbers.
  const lead =
    segment.state === "degraded" ? statusBarSegmentTooltip(segment) : name;
  return `${lead} · ${clauses.join("; ")}`;
}
