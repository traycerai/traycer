import type { ReactNode } from "react";
import { MonitorUp } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Stands in for a bot's running chats - the trunk and a thread's session -
 * on a host that does not run the bot (Tracy Bots T65): every host serves the
 * channel, but those chats are the bot's host's to show. `onOpenThere` moves
 * the tab to that host, offered only when this app can connect to it.
 */
export function BotSessionsElsewhere(props: {
  readonly onOpenThere: (() => void) | null;
}): ReactNode {
  const { onOpenThere } = props;
  return (
    <div
      role="status"
      data-testid="bot-sessions-elsewhere"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <MonitorUp className="size-4.5" aria-hidden="true" />
      </span>
      <p className="max-w-[48ch] text-ui-sm text-muted-foreground">
        This view is on the host running the bot.
      </p>
      {onOpenThere === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="bot-sessions-open-there"
          onClick={onOpenThere}
        >
          Open there
        </Button>
      )}
    </div>
  );
}
