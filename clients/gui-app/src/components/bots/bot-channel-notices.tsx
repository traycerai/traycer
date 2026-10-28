import type { ReactNode } from "react";

/**
 * A send that never reached the conversation: a message from the box, which
 * keeps its text for sending again, an option clicked, or a retry. It names
 * nothing to edit, since a retry of a teammate's message, or one with no box
 * beside it, has no edit to make.
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
      Couldn't send. Try again.
    </p>
  );
}

/**
 * A message the host accepted while the bot cannot be reached: it waits in
 * the bot's mailbox, and the bot reads it once it can be reached.
 */
export function BotQueuedNotice(props: { readonly testId: string }): ReactNode {
  return (
    <p
      role="status"
      className="text-ui-xs text-muted-foreground"
      data-testid={props.testId}
    >
      Saved. The bot will read it.
    </p>
  );
}
