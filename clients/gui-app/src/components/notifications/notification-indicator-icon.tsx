import { type CSSProperties, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BackgroundActivityGlyph } from "@/components/notifications/background-activity-glyph";
import {
  attentionTone,
  DONE_TONE,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { cn } from "@/lib/utils";

const BACKGROUND_ACTIVITY_TITLE = "Background activity — agent idle";

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
 * over live activity: errors first, then unresolved prompts, followed by the
 * session-backed running indicator (turn spinner, or the muted background
 * variant) and unread completion.
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
      <IndicatorSpan indicatorProps={props} title={props.runningTitle}>
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
      <IndicatorSpan indicatorProps={props} title={BACKGROUND_ACTIVITY_TITLE}>
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
    <span
      role="status"
      aria-label={props.tone.title}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        props.indicatorProps.className,
      )}
      style={props.indicatorProps.style}
      title={props.tone.title}
    >
      <Icon
        aria-hidden
        className={cn("size-3.5", props.tone.className)}
        data-testid={`${props.indicatorProps.testIdPrefix}-${props.tone.testId}-${props.indicatorProps.subjectId}`}
      />
    </span>
  );
}

function IndicatorDot(props: {
  readonly tone: IndicatorTone;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  return (
    <span
      role="status"
      aria-label={props.tone.title}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        props.indicatorProps.className,
      )}
      style={props.indicatorProps.style}
      title={props.tone.title}
    >
      <AgentSpinningDots
        className={props.tone.className}
        testId={`${props.indicatorProps.testIdPrefix}-${props.tone.testId}-${props.indicatorProps.subjectId}`}
        variant="static"
      />
    </span>
  );
}

function IndicatorSpan(props: {
  readonly indicatorProps: NotificationIndicatorIconProps;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span
      role="status"
      aria-label={props.title}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        props.indicatorProps.className,
      )}
      style={props.indicatorProps.style}
      title={props.title}
    >
      {props.children}
    </span>
  );
}
