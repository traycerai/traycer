import { useContext, useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { taskMentionDisplayTitle } from "@/lib/composer/mentions/task-mention-helpers";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";

// A name is one unit: it never breaks across lines, and a bot or task
// title longer than the row is cut.
const CHIP_CLASS = "rounded-sm px-0.5 font-medium whitespace-nowrap";
const TARGET_CHIP_CLASS = cn(
  CHIP_CLASS,
  "inline-block max-w-full cursor-pointer truncate bg-info/10 align-bottom text-info-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring",
);
const REMOVED_CHIP_CLASS = cn(CHIP_CLASS, "text-muted-foreground");

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
      <span
        data-testid="bot-mention-bot-removed"
        className={REMOVED_CHIP_CLASS}
      >
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
 * A task named in a message (decision 177): its title as a chip that opens
 * the task, or "a removed task" for one its context read does not find. A
 * task the tab does not list is read by its id. The token as written
 * outside a bot's tab and while that read has not answered.
 */
export function TaskMentionChip(props: {
  readonly taskId: string;
  readonly children: ReactNode;
}): ReactNode {
  const directory = useContext(BotMentionsContext);
  const listed =
    directory?.tasks.find((entry) => entry.id === props.taskId) ?? null;
  const userId = useAuthStore((s) => s.profile?.userId ?? null);
  const cloud = useAuthStore((s) => authorizesCloudCapability(s.status));
  const unlisted = useMemo(
    () => (directory !== null && listed === null ? [props.taskId] : []),
    [directory, listed, props.taskId],
  );
  const contexts = useEpicGetTaskContexts(unlisted, userId, {
    enabled: cloud,
  });
  const navigate = useNavigate();
  if (directory === null) return <>{props.children}</>;
  const read = contexts.tasksById.get(props.taskId)?.epic?.light ?? null;
  const title =
    listed?.name ?? (read === null ? null : taskMentionDisplayTitle(read));
  if (title === null) {
    // Removed only on the read's answer: unread, failed or not asked, the
    // token stays as written.
    if (!cloud || contexts.isPending || contexts.error !== null) {
      return <>{props.children}</>;
    }
    return (
      <span
        data-testid="bot-mention-task-removed"
        className={REMOVED_CHIP_CLASS}
      >
        a removed task
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
