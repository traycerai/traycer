import { type CSSProperties, type ReactNode } from "react";
import {
  createLucideIcon,
  MessageSquareCheck,
  MessageSquareWarning,
  MessageSquareX,
  type LucideIcon,
} from "lucide-react";
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
  readonly statusPresentation: "message" | "spinner";
}

/**
 * The single renderer for notification status icons. Notification state wins
 * over live activity: errors first, then unresolved prompts, followed by the
 * session-backed running spinner and unread completion.
 */
export function NotificationIndicatorIcon(
  props: NotificationIndicatorIconProps,
): ReactNode {
  const tone = attentionTone(props.state);
  if (tone !== null) {
    return <IndicatorTonePresentation tone={tone} indicatorProps={props} />;
  }
  if (props.running) {
    return (
      <IndicatorSpan
        indicatorProps={props}
        title={props.runningTitle}
        dotsClassName="text-current"
        testId={`${props.testIdPrefix}-activity-${props.subjectId}`}
      />
    );
  }
  if (props.state.unreadDone) {
    return (
      <IndicatorTonePresentation tone={DONE_TONE} indicatorProps={props} />
    );
  }
  return props.defaultIcon;
}

interface IndicatorTone {
  readonly testId: "failure" | "interview" | "approval" | "done";
  readonly title: string;
  readonly className: string;
  readonly Icon: LucideIcon;
}

const MessageSquareQuestionMark = createLucideIcon(
  "message-square-question-mark",
  [
    [
      "path",
      {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
        key: "18887p",
      },
    ],
    ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", key: "1u773s" }],
    ["path", { d: "M12 17h.01", key: "p32p05" }],
  ],
);

const DONE_TONE: IndicatorTone = {
  testId: "done",
  title: "Task completed",
  // `--success-foreground` (unlike `--success`) is verified >=3:1 against
  // every preset's `--background`/`--canvas` - see index.css.
  className: "text-success-foreground",
  Icon: MessageSquareCheck,
};

const FAILURE_TONE: IndicatorTone = {
  testId: "failure",
  title: "Task needs attention",
  className: "text-destructive",
  Icon: MessageSquareX,
};

const INTERVIEW_TONE: IndicatorTone = {
  testId: "interview",
  title: "Task waiting for your interview response",
  className: "text-warning-foreground",
  Icon: MessageSquareQuestionMark,
};

const APPROVAL_TONE: IndicatorTone = {
  testId: "approval",
  title: "Task waiting for your approval",
  className: "text-warning-foreground",
  Icon: MessageSquareWarning,
};

function attentionTone(
  state: NotificationIndicatorState,
): IndicatorTone | null {
  if (state.unreadFailure) return FAILURE_TONE;
  if (state.pendingInterview) return INTERVIEW_TONE;
  if (state.pendingApproval) return APPROVAL_TONE;
  return null;
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
  readonly dotsClassName: string;
  readonly testId: string;
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
        variant={undefined}
      />
    </span>
  );
}
