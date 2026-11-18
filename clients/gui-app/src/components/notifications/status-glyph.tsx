import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { MessageSquareClock } from "@/components/notifications/message-square-clock";
import type { IndicatorTone } from "@/components/notifications/notification-indicator-tones";
import { cn } from "@/lib/utils";

/**
 * What a status glyph draws: a notification tone, a running turn, or
 * background-only work.
 */
export type StatusGlyphStatus = IndicatorTone | "running" | "background";

/**
 * The one status glyph every agent-status surface draws, in the tone icons
 * the notification feed uses (`NOTIFICATION_STATUS_TONES`), the spinner for a
 * running turn and the chat-with-a-clock for background work. Each state is a
 * distinct shape, never colour alone. `label` names it for assistive tech;
 * pass `null` where the surrounding element already says the state.
 */
export function StatusGlyph(props: {
  readonly status: StatusGlyphStatus;
  readonly className: string | undefined;
  readonly testId: string | undefined;
  readonly label: string | null;
}): ReactNode {
  const a11y =
    props.label === null
      ? { "aria-hidden": true }
      : { role: "img", "aria-label": props.label };
  if (props.status === "running") {
    return (
      <span
        {...a11y}
        data-status-glyph="running"
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          props.className,
        )}
      >
        <AgentSpinningDots
          className={undefined}
          testId={props.testId}
          variant={undefined}
        />
      </span>
    );
  }
  if (props.status === "background") {
    return (
      <MessageSquareClock
        {...a11y}
        data-status-glyph="background"
        data-testid={props.testId}
        className={cn("shrink-0 text-muted-foreground", props.className)}
      />
    );
  }
  const Icon = props.status.Icon;
  return (
    <Icon
      {...a11y}
      data-status-glyph={props.status.testId}
      data-testid={props.testId}
      className={cn("shrink-0", props.status.className, props.className)}
    />
  );
}
