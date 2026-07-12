import { type CSSProperties, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { cn } from "@/lib/utils";

interface NotificationIndicatorIconProps {
  readonly state: NotificationIndicatorState;
  readonly running: boolean;
  readonly subjectId: string;
  readonly testIdPrefix: string;
  readonly className: string | undefined;
  readonly style: CSSProperties | undefined;
  readonly runningTitle: string;
  readonly defaultIcon: ReactNode;
}

/**
 * The single renderer presentation for notification dots. Notification state
 * deliberately wins over live activity: errors first, then unresolved prompts,
 * followed by the session-backed running spinner and unread completion.
 */
export function NotificationIndicatorIcon(
  props: NotificationIndicatorIconProps,
): ReactNode {
  const tone = attentionTone(props.state);
  if (tone !== null) {
    return <IndicatorDot tone={tone} indicatorProps={props} />;
  }
  if (props.running) {
    return (
      <IndicatorSpan
        indicatorProps={props}
        title={props.runningTitle}
        dotsClassName="text-current"
        testId={`${props.testIdPrefix}-activity-${props.subjectId}`}
        variant={undefined}
      />
    );
  }
  if (props.state.unreadDone) {
    return <IndicatorDot tone={DONE_TONE} indicatorProps={props} />;
  }
  return props.defaultIcon;
}

interface IndicatorTone {
  readonly testId: "failure" | "prompt" | "done";
  readonly title: string;
  readonly className: string;
}

const DONE_TONE: IndicatorTone = {
  testId: "done",
  title: "Task completed",
  className: "text-blue-500 dark:text-blue-400",
};

function attentionTone(
  state: NotificationIndicatorState,
): IndicatorTone | null {
  if (state.unreadFailure) {
    return {
      testId: "failure",
      title: "Task needs attention",
      className: "text-red-500 dark:text-red-400",
    };
  }
  if (state.pendingPrompt) {
    return {
      testId: "prompt",
      title: "Task waiting for your response",
      className: "text-amber-500 dark:text-amber-400",
    };
  }
  return null;
}

function IndicatorDot(props: {
  readonly tone: IndicatorTone;
  readonly indicatorProps: NotificationIndicatorIconProps;
}): ReactNode {
  return (
    <IndicatorSpan
      indicatorProps={props.indicatorProps}
      title={props.tone.title}
      dotsClassName={props.tone.className}
      testId={`${props.indicatorProps.testIdPrefix}-${props.tone.testId}-${props.indicatorProps.subjectId}`}
      variant="static"
    />
  );
}

function IndicatorSpan(props: {
  readonly indicatorProps: NotificationIndicatorIconProps;
  readonly title: string;
  readonly dotsClassName: string;
  readonly testId: string;
  readonly variant: "static" | undefined;
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
      <AgentSpinningDots
        className={cn(props.dotsClassName)}
        testId={props.testId}
        variant={props.variant}
      />
    </span>
  );
}
