import type { ReactNode } from "react";

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
