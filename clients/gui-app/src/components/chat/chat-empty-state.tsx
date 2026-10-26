import { use } from "react";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { ChatBotPresentationContext } from "./chat-bot-presentation-context";

export function ChatEmptyState() {
  const ChatIcon = EPIC_NODE_ICONS.chat;
  const bot = use(ChatBotPresentationContext);
  if (bot !== null)
    return (
      <BotEmptyState channel={bot.threadLine !== null} title={bot.botTitle} />
    );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-border/40 bg-muted/15 text-muted-foreground/45">
        <ChatIcon className="size-4" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-ui-sm font-medium text-muted-foreground/60">
          Start the conversation
        </p>
        <p className="text-ui-sm leading-6 text-muted-foreground/50">
          Send a message to get started.
        </p>
      </div>
    </div>
  );
}

/**
 * An empty bot channel opens as Slack's does, with the bot's picture and
 * name and where the person's channel with it begins; an empty thread says
 * it has no reply yet.
 */
function BotEmptyState(props: {
  readonly channel: boolean;
  readonly title: string;
}) {
  if (!props.channel) {
    return (
      <p className="px-4 py-6 text-ui-sm text-muted-foreground">
        No replies yet.
      </p>
    );
  }
  return (
    <div
      className="flex h-full flex-col justify-end gap-1 px-6 pb-4"
      data-testid="bot-channel-intro"
    >
      <p className="flex items-center gap-2 text-ui-lg font-bold text-foreground">
        <BotAvatar size="sm" />
        <span className="truncate">{props.title}</span>
      </p>
      <p className="text-ui-sm text-muted-foreground">
        This is the beginning of your channel with{" "}
        <span className="font-medium text-foreground">{props.title}</span>.
      </p>
    </div>
  );
}
