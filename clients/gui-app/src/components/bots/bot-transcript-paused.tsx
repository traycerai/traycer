import type { ReactNode } from "react";
import { CloudOff } from "lucide-react";

/**
 * Stands in for a bot chat's transcript while the bot is paused from this tab
 * (Tracy Bots): only the host that runs the bot serves its chats, and that
 * host cannot be reached from here now. What the tab CAN do - list the
 * conversations, accept a message for later delivery - keeps working around
 * this placeholder; the banner above says why the bot is paused.
 */
export function BotTranscriptPaused(): ReactNode {
  return (
    <div
      role="status"
      data-testid="bot-transcript-paused"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <CloudOff className="size-4.5" aria-hidden="true" />
      </span>
      <p className="max-w-[48ch] text-ui-sm text-muted-foreground">
        The conversation shows here once the bot can be reached.
      </p>
    </div>
  );
}
