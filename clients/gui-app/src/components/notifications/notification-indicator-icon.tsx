import { type CSSProperties, type ReactNode } from "react";
import { UnknownActivityGlyph } from "@/components/notifications/unknown-activity-glyph";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import {
  attentionTone,
  DONE_TONE,
  terminalFailureTone,
  type AgentNotificationSurface,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useStatusGlyphTooltipOpen } from "@/components/notifications/status-glyph-focus";
import {
  StatusGlyph,
  type StatusGlyphStatus,
} from "@/components/notifications/status-glyph";
import { cn } from "@/lib/utils";

export const BACKGROUND_ACTIVITY_TITLE = "Background activity — agent idle";

/**
 * The tooltip for {@link AgentActivityCoverage} `"unserved"`. Says what is
 * missing (this device's view) rather than what is wrong (nothing is), because
 * nothing here is broken: the serving host built a narrow union and the agent
 * may be perfectly busy on another machine.
 */
export const UNKNOWN_ACTIVITY_TITLE =
  "Agent status unknown. This device isn't receiving activity for its machine.";

/**
 * Qualifies activity read from a union that reaches some of the account's
 * hosts but not all: what it shows is real, and more may be running where it
 * cannot see.
 */
export const PARTIAL_ACTIVITY_NOTICE =
  "Can't check everything that's running right now";

/**
 * Live-activity tier for the running slot. `"turn"` is the agent actually
 * processing (an active or activating turn — the busy spinner); `"background"`
 * is background-only work (Monitor / `run_in_background` / a scheduled
 * wakeup) keeping the chat non-idle while the agent itself is NOT running —
 * rendered calmer and muted so the two are distinguishable at a glance.
 * Callers resolve the tier (turn wins when both are happening); this
 * component only presents it.
 */
export type IndicatorRunningKind = "turn" | "background" | false;

interface NotificationIndicatorIconProps {
  readonly state: NotificationIndicatorState;
  readonly running: IndicatorRunningKind;
  /**
   * What the served activity plane can say about this subject's host.
   *
   * A SEPARATE axis from {@link running}, not a fourth member of it, and the
   * separation is the whole point: `running` is a claim the plane MADE, and
   * this is whether the plane was in a position to make one at all. Folding
   * them together would put "we don't know" in the precedence slot where a
   * spinner outranks an unread completion, which is backwards - an unknown
   * reading must never displace a fact somebody else reported.
   *
   * So it is consulted LAST, in `defaultIcon`'s slot: every attention tone,
   * every running claim, the unread-done marker and the terminal outcome are
   * all facts a producer stated, and they outrank the absence of one.
   *
   * Required at every call site, never defaulted: a surface that renders an
   * agent's status has to answer whether it can see that agent's machine, and
   * `"indeterminate"` is the answer for one that cannot name a host - said out
   * loud rather than inherited from a default nobody read.
   */
  readonly activityCoverage: AgentActivityCoverage;
  readonly subjectId: string;
  readonly testIdPrefix: string;
  readonly className: string | undefined;
  readonly style: CSSProperties | undefined;
  readonly runningTitle: string;
  readonly defaultIcon: ReactNode;
  /** Agent surface whose identity owns the failure glyph. "Terminal" in the
   * indicator state means a latest outcome, not necessarily a TUI agent. */
  readonly agentSurface: AgentNotificationSurface;
}

/**
 * The single renderer for notification status icons, drawn through the shared
 * `StatusGlyph`. Notification state wins over live activity for high-attention
 * states: chat/other failures first, then unresolved prompts, followed by the
 * session-backed running glyph (turn, or the calmer background glyph), unread
 * completion, and finally terminal failure. Producers retain historical
 * failures in the feed while projecting only the latest terminal outcome into
 * this renderer.
 */
export function NotificationIndicatorIcon(
  props: NotificationIndicatorIconProps,
): ReactNode {
  const tone = attentionTone(props.state);
  if (tone !== null) {
    return <IndicatorToneStatus tone={tone} indicatorProps={props} />;
  }
  if (props.running === "turn") {
    return (
      <GlyphStatus
        status="running"
        tooltip={props.runningTitle}
        testId={`${props.testIdPrefix}-activity-${props.subjectId}`}
        indicatorProps={props}
      />
    );
  }
  if (props.running === "background") {
    return (
      <GlyphStatus
        status="background"
        tooltip={BACKGROUND_ACTIVITY_TITLE}
        testId={`${props.testIdPrefix}-background-activity-${props.subjectId}`}
        indicatorProps={props}
      />
    );
  }
  if (props.state.unreadDone) {
    return <IndicatorToneStatus tone={DONE_TONE} indicatorProps={props} />;
  }
  const terminalTone = terminalFailureTone(props.state, props.agentSurface);
  if (terminalTone !== null) {
    return <IndicatorToneStatus tone={terminalTone} indicatorProps={props} />;
  }
  // LAST, and only here: the idle glyph is the one slot that renders a
  // CONCLUSION drawn from silence ("nothing is happening"), and `unserved` is
  // exactly the state in which this app is not entitled to draw it. Everything
  // above is something a producer said, and none of it is displaced by an
  // absent view. `indeterminate` deliberately falls through to the idle glyph
  // (see `AgentActivityCoverage`).
  if (props.activityCoverage === "unserved") {
    return (
      <IndicatorSpan indicatorProps={props} tooltip={UNKNOWN_ACTIVITY_TITLE}>
        <UnknownActivityGlyph
          testId={`${props.testIdPrefix}-unknown-activity-${props.subjectId}`}
        />
      </IndicatorSpan>
    );
  }
  return props.defaultIcon;
}

function IndicatorToneStatus(props: {
  readonly tone: IndicatorTone;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  return (
    <GlyphStatus
      status={props.tone}
      tooltip={props.tone.title}
      testId={`${props.indicatorProps.testIdPrefix}-${props.tone.testId}-${props.indicatorProps.subjectId}`}
      indicatorProps={props.indicatorProps}
    />
  );
}

function GlyphStatus(props: {
  readonly status: StatusGlyphStatus;
  readonly tooltip: string;
  readonly testId: string;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  return (
    <IndicatorSpan
      indicatorProps={props.indicatorProps}
      tooltip={props.tooltip}
    >
      <StatusGlyph
        status={props.status}
        className="size-3.5"
        testId={props.testId}
        label={null}
      />
    </IndicatorSpan>
  );
}

/**
 * The one status-glyph leaf: `role="status"` + accessible name + the hover
 * tooltip. The variants above differ only in their glyph, and each used to
 * re-spell this span - including its own native `title`, which is
 * how three copies of the same "aria-label and title say the same thing"
 * pairing ended up here.
 *
 * The prop is `tooltip`, not `title`: `title` on a component that spreads onto
 * a DOM node is indistinguishable at the call site from the native attribute
 * this replaces.
 */
function IndicatorSpan(props: {
  readonly indicatorProps: NotificationIndicatorIconProps;
  readonly tooltip: string;
  readonly children: ReactNode;
}): ReactNode {
  // Held open while the containing history row's target has keyboard focus
  // (`StatusGlyphFocusContext`); plain hover everywhere else.
  const tooltipOpen = useStatusGlyphTooltipOpen();
  return (
    <TooltipWrapper
      label={props.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
      open={tooltipOpen.open}
      onOpenChange={tooltipOpen.onOpenChange}
    >
      <span
        role="status"
        aria-label={props.tooltip}
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center",
          props.indicatorProps.className,
        )}
        style={props.indicatorProps.style}
      >
        {props.children}
      </span>
    </TooltipWrapper>
  );
}
