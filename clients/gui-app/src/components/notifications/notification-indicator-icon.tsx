import { type CSSProperties, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BackgroundActivityGlyph } from "@/components/notifications/background-activity-glyph";
import {
  attentionTone,
  DONE_TONE,
  terminalFailureTone,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

export const BACKGROUND_ACTIVITY_TITLE = "Background activity — agent idle";

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
  readonly subjectId: string;
  readonly testIdPrefix: string;
  readonly className: string | undefined;
  readonly style: CSSProperties | undefined;
  readonly runningTitle: string;
  readonly defaultIcon: ReactNode;
  readonly statusPresentation: "message" | "spinner";
}

/**
 * The single renderer for notification status icons. Notification state wins
 * over live activity for high-attention states: chat/other failures first,
 * then unresolved prompts, followed by the session-backed running indicator
 * (turn spinner, or the muted background variant), unread completion, and
 * finally terminal failure. Producers suppress historical failures per exact
 * entity before aggregate state reaches this renderer.
 */
export function NotificationIndicatorIcon(
  props: NotificationIndicatorIconProps,
): ReactNode {
  const tone = attentionTone(props.state);
  if (tone !== null) {
    return <IndicatorTonePresentation tone={tone} indicatorProps={props} />;
  }
  if (props.running === "turn") {
    return (
      <IndicatorSpan indicatorProps={props} tooltip={props.runningTitle}>
        <AgentSpinningDots
          className="text-current"
          testId={`${props.testIdPrefix}-activity-${props.subjectId}`}
          variant={undefined}
        />
      </IndicatorSpan>
    );
  }
  if (props.running === "background") {
    return (
      <IndicatorSpan indicatorProps={props} tooltip={BACKGROUND_ACTIVITY_TITLE}>
        <BackgroundActivityGlyph
          testId={`${props.testIdPrefix}-background-activity-${props.subjectId}`}
        />
      </IndicatorSpan>
    );
  }
  if (props.state.unreadDone) {
    return (
      <IndicatorTonePresentation tone={DONE_TONE} indicatorProps={props} />
    );
  }
  const terminalTone = terminalFailureTone(props.state);
  if (terminalTone !== null) {
    return (
      <IndicatorTonePresentation tone={terminalTone} indicatorProps={props} />
    );
  }
  return props.defaultIcon;
}

function IndicatorTonePresentation(props: {
  readonly tone: IndicatorTone;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  if (props.indicatorProps.statusPresentation === "message") {
    return <IndicatorStatus {...props} />;
  }
  return <IndicatorDot {...props} />;
}

function IndicatorStatus(props: {
  readonly tone: IndicatorTone;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  const Icon = props.tone.Icon;
  return (
    <IndicatorSpan
      indicatorProps={props.indicatorProps}
      tooltip={props.tone.title}
    >
      <Icon
        aria-hidden
        className={cn("size-3.5", props.tone.className)}
        data-testid={`${props.indicatorProps.testIdPrefix}-${props.tone.testId}-${props.indicatorProps.subjectId}`}
      />
    </IndicatorSpan>
  );
}

function IndicatorDot(props: {
  readonly tone: IndicatorTone;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  return (
    <IndicatorSpan
      indicatorProps={props.indicatorProps}
      tooltip={props.tone.title}
    >
      <AgentSpinningDots
        className={props.tone.className}
        testId={`${props.indicatorProps.testIdPrefix}-${props.tone.testId}-${props.indicatorProps.subjectId}`}
        variant="static"
      />
    </IndicatorSpan>
  );
}

/**
 * The one status-glyph leaf: `role="status"` + accessible name + the hover
 * tooltip. The tone/dot/running variants above differ only in their glyph, and
 * each used to re-spell this span - including its own native `title`, which is
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
  return (
    <TooltipWrapper
      label={props.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
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
