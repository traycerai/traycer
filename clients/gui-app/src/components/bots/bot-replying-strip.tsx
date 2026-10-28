import type { ReactNode } from "react";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";

/**
 * Slack's typing line, in a bot channel's or thread's message box dock and
 * never a row of the list: the bot's picture and "Tracy is replying…", and
 * never what the turn is doing. Drawn only while the session is replying;
 * `null` is a session with nothing to show.
 */
export function BotReplyingStrip(props: {
  readonly botTitle: string;
  readonly activity: BotSessionActivity | null;
  readonly testId: string;
}): ReactNode {
  const { botTitle, activity, testId } = props;
  if (activity === null || activity.state !== "replying") return null;
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex min-w-0 shrink-0 items-center gap-2 px-5 pt-1 text-ui-xs text-muted-foreground"
    >
      <BotAvatar size="sm" />
      <WorkingShimmerText className="min-w-0 truncate">
        {`${botTitle} is replying…`}
      </WorkingShimmerText>
    </div>
  );
}
