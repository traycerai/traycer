import type { ReactNode } from "react";
import { CloudOff } from "lucide-react";

/**
 * Stands in for a bot chat's transcript while the host that serves it is
 * offline (Tracy Bots). Only the bound host serves a bot's chats, so a tab
 * opened through another host has nothing to subscribe to; what it CAN do -
 * list the conversations, accept a message for later delivery, move the bot
 * here - keeps working around this placeholder.
 */
export function BotTranscriptOffline(props: {
  readonly hostLabel: string;
}): ReactNode {
  return (
    <div
      role="status"
      data-testid="bot-transcript-offline"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <CloudOff className="size-4.5" aria-hidden="true" />
      </span>
      <p className="max-w-[48ch] text-ui-sm text-muted-foreground">
        The conversation is available when {props.hostLabel} is back. A message
        you send now is saved and delivered then.
      </p>
    </div>
  );
}
