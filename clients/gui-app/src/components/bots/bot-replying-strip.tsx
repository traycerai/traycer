import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { RunningFor } from "@/components/chat/chat-bot-message";
import type { ChatBotTurnReceipt } from "@/components/chat/chat-bot-presentation-context";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";

/**
 * Slack's typing line, in a bot channel's or thread's message box dock and
 * never a row of the list: the bot's picture and "Tracy is replying…", and
 * never what the turn is doing. Drawn only while the session is replying;
 * `null` is a session with nothing to show.
 *
 * Once the host names the turn (`turn`), the line is the way into it, as the
 * receipt under a finished reply is: it reads the same at rest, and hovered
 * or focused it says "View turn" and how long the turn has been running. On
 * a touch screen the whole line takes the tap at the touch minimum, past its
 * drawn height, which stays the dock's. The line stays the status either
 * way: the button is named by the replying text, and what it shows on hover
 * is kept out of what the status announces.
 */
export function BotReplyingStrip(props: {
  readonly botTitle: string;
  readonly activity: BotSessionActivity | null;
  readonly turn: ChatBotTurnReceipt | null;
  readonly testId: string;
}): ReactNode {
  const { botTitle, activity, turn, testId } = props;
  if (activity === null || activity.state !== "replying") return null;
  const replying = `${botTitle} is replying…`;
  const picture = <BotAvatar size="sm" />;
  return (
    <div
      role="status"
      data-testid={testId}
      className="relative flex min-w-0 shrink-0 items-center gap-2 px-5 pt-1 text-ui-xs text-muted-foreground"
    >
      {turn === null ? (
        <>
          {picture}
          <WorkingShimmerText className="min-w-0 truncate">
            {replying}
          </WorkingShimmerText>
        </>
      ) : (
        <button
          type="button"
          aria-label={replying}
          onClick={turn.open}
          className="group/replying -my-0.5 -ml-1 flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-[color,background-color,box-shadow] hover:bg-foreground/5 hover:text-foreground hover:ring-1 hover:ring-border/60 focus-visible:bg-foreground/5 focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-border/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-full pointer-coarse:after:min-h-11 pointer-coarse:after:-translate-y-1/2"
        >
          {picture}
          <WorkingShimmerText className="min-w-0 truncate group-hover/replying:hidden group-focus-visible/replying:hidden">
            {replying}
          </WorkingShimmerText>
          <span
            aria-hidden="true"
            className="hidden min-w-0 truncate group-hover/replying:block group-focus-visible/replying:block"
          >
            {"View turn · "}
            <RunningFor startedAt={turn.startedAt} />
          </span>
          <ChevronRight
            aria-hidden="true"
            className="hidden size-3 shrink-0 group-hover/replying:block group-focus-visible/replying:block"
          />
        </button>
      )}
    </div>
  );
}
