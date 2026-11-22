import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { Badge } from "@/components/ui/badge";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  describeTaskInterval,
  firstLineOf,
  sortTasksForDisplay,
  taskRequestPost,
  type BotTaskRequestPost,
} from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { cn } from "@/lib/utils";

const EMPTY_TASK_IDS: ReadonlyArray<string> = [];

/**
 * The tasks one thread of a bot set up (Tracy Bots T82), in its panel, one
 * row each: the task's title, opening the task, what the bot named it, the
 * post it was set up for, and an automation's interval. A one-off task shows
 * no interval, and an entry from a host that predates where a task came from
 * shows no post.
 */
export function BotTaskList(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** The bot's threads, as listed; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  /** The thread whose panel lists them. */
  readonly threadId: string;
}): ReactNode {
  const { botId, hostId, tasks, threads, threadId } = props;
  const userId = useAuthStore((s) => s.profile?.userId ?? null);
  const taskIds = useMemo(
    () => (tasks.length === 0 ? EMPTY_TASK_IDS : tasks.map((t) => t.taskId)),
    [tasks],
  );
  const contexts = useEpicGetTaskContexts(taskIds, userId, {
    enabled: taskIds.length > 0,
  });
  const sorted = useMemo(() => sortTasksForDisplay(tasks), [tasks]);
  return (
    <ul className="flex flex-col gap-1">
      {sorted.map((task) => (
        <li key={task.taskId}>
          <BotTaskRow
            botId={botId}
            hostId={hostId}
            task={task}
            title={
              contexts.tasksById.get(task.taskId)?.epic?.light?.title ?? null
            }
            post={taskRequestPost(task, threads ?? [], null)}
            threadId={threadId}
          />
        </li>
      ))}
    </ul>
  );
}

function BotTaskRow(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly task: BotTaskEntry;
  readonly title: string | null;
  readonly post: BotTaskRequestPost | null;
  readonly threadId: string;
}): ReactNode {
  const { botId, hostId, task, title, post, threadId } = props;
  const working = useEpicAgentActivity(task.taskId).working.size;
  const navigate = useNavigate();
  const tracking = task.state === "tracking";
  const interval = describeTaskInterval(task);
  const openTask = (): void =>
    navigateToTabIntent(
      navigate,
      openEpicFromListIntent({
        epicId: task.taskId,
        focus: undefined,
        name: title ?? undefined,
        replaceEmptyDraftId: null,
      }),
      undefined,
    );
  return (
    <div
      data-testid="bot-task-row"
      data-task-id={task.taskId}
      data-task-state={task.state}
      className={cn(
        "flex flex-col gap-0.5 rounded-md px-2 py-1.5",
        !tracking && "opacity-70",
      )}
    >
      <span className="flex items-center gap-2">
        <button
          type="button"
          data-testid="bot-task-open"
          className="min-w-0 flex-1 truncate text-left text-ui-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={openTask}
        >
          {title ?? task.taskId}
        </button>
        {working > 0 ? (
          <Badge variant="success" size="xs">
            {working === 1 ? "1 agent working" : `${working} agents working`}
          </Badge>
        ) : null}
        {tracking ? null : (
          <Badge variant="muted" size="xs">
            Ended
          </Badge>
        )}
      </span>
      {task.label === null ? null : (
        <span
          className="truncate text-ui-xs text-foreground"
          data-testid="bot-task-label"
        >
          {task.label}
        </span>
      )}
      <span className="flex min-w-0 flex-wrap gap-x-2 text-ui-xs text-muted-foreground">
        {interval === null ? null : (
          <span data-testid="bot-task-interval">{interval}</span>
        )}
        <ThreadPanelRequestLine
          botId={botId}
          hostId={hostId}
          post={post}
          threadId={threadId}
        />
        {task.endedReason === null ? null : <span>{task.endedReason}</span>}
      </span>
    </div>
  );
}

/**
 * "for <the message's first line>" in a thread's panel, as plain text: the
 * post the thread hangs off, or a message of this thread. Nothing while the
 * row is not loaded.
 */
function ThreadPanelRequestLine(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly post: BotTaskRequestPost | null;
  readonly threadId: string;
}): ReactNode {
  const { botId, hostId, post, threadId } = props;
  if (post === null) return null;
  if (post.kind === "thread-message" && post.threadId !== threadId) {
    return null;
  }
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={post.kind === "channel" ? post.chatId : post.threadId}
      messageId={post.messageId}
      fetchCold={false}
    >
      {(row) => {
        const line = firstLineOf(postTextOf(row));
        return line === null ? null : (
          <span className="min-w-0 truncate" data-testid="bot-task-request">
            for {line}
          </span>
        );
      }}
    </ChannelPost>
  );
}
