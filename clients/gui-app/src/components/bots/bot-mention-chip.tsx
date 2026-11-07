import { useContext, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import { cn } from "@/lib/utils";

// A name is one unit: it never breaks across lines, and a bot or task
// title longer than the row is cut.
const CHIP_CLASS = "rounded-sm px-0.5 font-medium whitespace-nowrap";
const TARGET_CHIP_CLASS = cn(
  CHIP_CLASS,
  "inline-block max-w-full cursor-pointer truncate bg-info/10 align-bottom text-info-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring",
);
// A name the tab cannot show: a bot known to be gone, or a task it does not list.
const MUTED_CHIP_CLASS = cn(CHIP_CLASS, "text-muted-foreground");

/**
 * A mention in a message box: the chip the posted row draws, with nothing to
 * open, since a click there places the caret.
 */
export function BotBoxMentionChip(props: {
  readonly token: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span
      data-testid="bot-box-mention"
      data-token={props.token}
      className={cn(
        CHIP_CLASS,
        "inline-block max-w-full truncate bg-info/10 align-bottom text-info-foreground",
      )}
    >
      {props.children}
    </span>
  );
}

/**
 * A mention in a message: the member's name as a chip, highlighted when it
 * is the viewer; the token as written where it names no member.
 */
export function BotMentionChip(props: {
  readonly userId: string;
  readonly children: ReactNode;
}): ReactNode {
  const directory = useContext(BotMentionsContext);
  const mentioned = directory === null ? null : directory.person(props.userId);
  if (mentioned === null) return <>{props.children}</>;
  return (
    <span
      data-testid="bot-mention"
      data-self={mentioned.self ? "true" : "false"}
      className={cn(
        CHIP_CLASS,
        mentioned.self
          ? "bg-warning/20 text-warning-foreground"
          : "bg-info/10 text-info-foreground",
      )}
    >
      {`@${mentioned.name}`}
    </span>
  );
}

/**
 * A bot of the environment named in a message (decision 177): its title as
 * a chip that opens its channel, or "a removed bot" for one the
 * environment no longer lists. The token as written outside a bot's tab and
 * while the environment's bots are unread.
 */
export function BotChannelMentionChip(props: {
  readonly botId: string;
  readonly children: ReactNode;
}): ReactNode {
  const directory = useContext(BotMentionsContext);
  const openChannel = useOpenBotChannel();
  if (directory === null || directory.bots === null) {
    return <>{props.children}</>;
  }
  const bot = directory.bots.find((entry) => entry.id === props.botId);
  if (bot === undefined) {
    return (
      <span data-testid="bot-mention-bot-removed" className={MUTED_CHIP_CLASS}>
        a removed bot
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="bot-mention-bot"
      data-bot-id={bot.id}
      className={TARGET_CHIP_CLASS}
      onClick={() => openChannel(bot.id, null)}
    >
      {`@${bot.name}`}
    </button>
  );
}

/**
 * A task of the bot's environment named in a message (decision 177): its
 * title as a chip that opens the task, for a task the tab's directory lists.
 * Any other id is "a task", even one the viewer can open: it may be another
 * environment's, which this channel never names, or one of this
 * environment's the directory does not hold, which is not a sign it is gone.
 * The token as written outside a bot's tab.
 */
export function TaskMentionChip(props: {
  readonly taskId: string;
  readonly children: ReactNode;
}): ReactNode {
  const directory = useContext(BotMentionsContext);
  const navigate = useNavigate();
  if (directory === null) return <>{props.children}</>;
  const title =
    directory.tasks.find((entry) => entry.id === props.taskId)?.name ?? null;
  if (title === null) {
    return (
      <span
        data-testid="bot-mention-task-unlisted"
        data-task-id={props.taskId}
        className={MUTED_CHIP_CLASS}
      >
        a task
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="bot-mention-task"
      data-task-id={props.taskId}
      className={TARGET_CHIP_CLASS}
      onClick={() =>
        navigateToTabIntent(
          navigate,
          openEpicFromListIntent({
            epicId: props.taskId,
            focus: undefined,
            name: title,
            replaceEmptyDraftId: null,
          }),
          undefined,
        )
      }
    >
      {`@${title}`}
    </button>
  );
}
