import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";

/**
 * A send that never reached the conversation: the message is still the
 * person's, back in the box, and sending again is a plain send.
 */
export function BotSendFailedNotice(props: {
  readonly testId: string;
}): ReactNode {
  return (
    <p
      role="alert"
      data-testid={props.testId}
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive"
    >
      Couldn't send. Edit and try again.
    </p>
  );
}

/**
 * The bot's answer to a message the conversation already holds failed or is
 * held: said under the last row until a later message gets a reply, with
 * nothing to send again. Its reason is in "Under the hood". Drawn only while
 * the session answering it is parked (a delivery it could not start) or
 * failed, read from its state alone; the typing line is drawn only while it
 * replies, so the two never show together.
 */
export function BotUnansweredNotice(props: {
  readonly botTitle: string;
  readonly activity: BotSessionActivity | null;
  readonly testId: string;
}): ReactNode {
  const { activity } = props;
  if (
    activity === null ||
    (activity.state !== "parked" && activity.state !== "failed")
  ) {
    return null;
  }
  // Held is degraded, failed is an error; the words are the same.
  return (
    <p
      role="status"
      data-testid={props.testId}
      data-state={activity.state}
      className={cn(
        "mx-5 mt-1 rounded-md border px-3 py-2 text-ui-xs",
        activity.state === "parked"
          ? "border-warning/30 bg-warning/10 text-warning-foreground"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {props.botTitle} couldn't answer this. Send another message.
    </p>
  );
}
