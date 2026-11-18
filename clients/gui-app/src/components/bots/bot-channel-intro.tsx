import type { ReactNode } from "react";
import { BotAvatar } from "@/components/bots/bot-avatars";

/**
 * The top of a bot channel nobody has written in yet, as Slack opens a new
 * channel: the bot's picture and name, that this is where the person's
 * channel with it begins, and what the bot does (its directive), which is
 * what the channel is for.
 */
export function BotChannelIntro(props: {
  readonly botTitle: string;
  readonly directive: string | null;
}): ReactNode {
  const { botTitle, directive } = props;
  return (
    <div
      data-testid="bot-channel-intro"
      className="flex flex-1 flex-col justify-end gap-1 px-5 pt-6 pb-4"
    >
      <BotAvatar size="lg" />
      <p className="mt-3 truncate text-ui-lg font-semibold text-foreground">
        {botTitle}
      </p>
      <p className="text-ui-sm text-muted-foreground">
        This is the beginning of your channel with{" "}
        <span className="font-medium text-foreground">{botTitle}</span>.
      </p>
      {directive === null || directive.trim().length === 0 ? null : (
        <p className="max-w-xl whitespace-pre-line text-ui-sm text-muted-foreground">
          {directive}
        </p>
      )}
    </div>
  );
}
