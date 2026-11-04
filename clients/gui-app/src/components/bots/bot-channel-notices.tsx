import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FAILED_NOTICE =
  "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive";

/**
 * A send that never reached the conversation: a message from the box, an
 * option clicked, or a retry. It names nothing to edit, since a retry of a
 * teammate's message, or one with no box beside it, has no edit to make.
 *
 * A message of the box that failed after the person began a newer draft is
 * named, with Restore (`restore`) to put it back in the box in place of
 * what the box holds; `null` where the box holds what failed, or there is
 * no box.
 */
export function BotSendFailedNotice(props: {
  readonly testId: string;
  readonly restore: {
    readonly text: string;
    readonly onRestore: () => void;
  } | null;
}): ReactNode {
  const { testId, restore } = props;
  if (restore === null) {
    return (
      <p role="alert" data-testid={testId} className={FAILED_NOTICE}>
        Couldn't send. Try again.
      </p>
    );
  }
  return (
    <p
      role="alert"
      data-testid={testId}
      className={cn(FAILED_NOTICE, "flex items-center gap-1")}
    >
      <span className="shrink-0">Couldn't send:</span>
      <span className="min-w-0 flex-1 truncate">{restore.text}</span>
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        data-testid={`${testId}-restore`}
        onClick={restore.onRestore}
      >
        Restore
      </Button>
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
