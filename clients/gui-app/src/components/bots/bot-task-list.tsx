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
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { cn } from "@/lib/utils";

const EMPTY_TASK_IDS: ReadonlyArray<string> = [];

/**
 * Where a task list is shown: the bot's own view, where a row names the
 * thread that set its task up and opens its post in the channel, or one
 * thread's panel, where every row is that thread's and nothing opens.
 */
export type BotTaskListPlace =
  | {
      readonly kind: "bot";
      /** The bot's channel; `null` from a host that does not name it. */
      readonly channelId: string | null;
      readonly onOpenPost: (open: BotOpenThread) => void;
    }
  | { readonly kind: "thread"; readonly threadId: string };

/**
 * A bot's tasks (Tracy Bots T82), one row each: the task's title, opening
 * the task, what the bot named it, the post it was set up for, the thread
 * that set it up, and an automation's interval. A one-off task shows no
 * interval, and an entry from a host that predates where a task came from
 * shows neither the post nor the thread.
 */
export function BotTaskList(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** The bot's threads, as listed; empty while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary>;
  readonly place: BotTaskListPlace;
}): ReactNode {
  const { botId, hostId, tasks, threads, place } = props;
  const userId = useAuthStore((s) => s.profile?.userId ?? null);
  const taskIds = useMemo(
    () => (tasks.length === 0 ? EMPTY_TASK_IDS : tasks.map((t) => t.taskId)),
    [tasks],
  );
  const contexts = useEpicGetTaskContexts(taskIds, userId, {
    enabled: taskIds.length > 0,
  });
  const sorted = useMemo(() => sortTasksForDisplay(tasks), [tasks]);
  const channelId = place.kind === "bot" ? place.channelId : null;
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
            post={taskRequestPost(task, threads, channelId)}
            creator={
              task.createdByChatId === null
                ? null
                : (threads.find(
                    (thread) => thread.threadId === task.createdByChatId,
                  ) ?? null)
            }
            place={place}
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
  /** The thread that set the task up, when the list has it. */
  readonly creator: BotThreadSummary | null;
  readonly place: BotTaskListPlace;
}): ReactNode {
  const { botId, hostId, task, title, post, creator, place } = props;
  const working = useEpicAgentActivity(task.taskId).working.size;
  const navigate = useNavigate();
  const tracking = task.state === "tracking";
  const interval = describeTaskInterval(task);
  // The thread is named only where the row does not already say it: not in
  // its own panel, and not when the post the task was set up for opens it.
  const namesCreator =
    task.createdByChatId !== null &&
    place.kind === "bot" &&
    !(
      post?.kind === "channel" && post.thread?.threadId === task.createdByChatId
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
          onClick={() =>
            navigateToTabIntent(
              navigate,
              openEpicFromListIntent({
                epicId: task.taskId,
                focus: undefined,
                name: title ?? undefined,
                replaceEmptyDraftId: null,
              }),
              undefined,
            )
          }
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
        {post === null ? null : (
          <TaskRequestLine
            botId={botId}
            hostId={hostId}
            post={post}
            place={place}
          />
        )}
        {namesCreator ? (
          <TaskCreatorLine
            botId={botId}
            hostId={hostId}
            creator={creator}
            place={place}
          />
        ) : null}
        {task.endedReason === null ? null : <span>{task.endedReason}</span>}
      </span>
    </div>
  );
}

/**
 * "for <the post's first line>": in the bot's view a channel post, opening
 * its thread in the channel (or the box that starts one); in a thread's
 * panel the post or a message of that thread, as plain text. A message of
 * another thread is named by its thread instead, and a post whose row is not
 * loaded is named by nothing.
 */
function TaskRequestLine(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly post: BotTaskRequestPost;
  readonly place: BotTaskListPlace;
}): ReactNode {
  const { botId, hostId, post, place } = props;
  if (post.kind === "thread-message") {
    if (place.kind !== "thread" || place.threadId !== post.threadId) {
      return null;
    }
    return (
      <PostLine
        botId={botId}
        hostId={hostId}
        chatId={post.threadId}
        messageId={post.messageId}
        onOpen={null}
      />
    );
  }
  const onOpen =
    place.kind === "bot"
      ? () =>
          place.onOpenPost({
            anchorMessageId: post.messageId,
            announcement: post.thread === null,
            sent: null,
          })
      : null;
  return (
    <PostLine
      botId={botId}
      hostId={hostId}
      chatId={post.chatId}
      messageId={post.messageId}
      onOpen={onOpen}
    />
  );
}

function PostLine(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  const { botId, hostId, chatId, messageId, onOpen } = props;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={chatId}
      messageId={messageId}
      fetchCold={false}
    >
      {(row) => {
        const line = firstLineOf(postTextOf(row));
        if (line === null) return null;
        return (
          <RowLink onOpen={onOpen} testId="bot-task-request">
            for {line}
          </RowLink>
        );
      }}
    </ChannelPost>
  );
}

/**
 * "from <the thread's post>", opening that thread in the channel; "from a
 * thread" while the list does not have it, or its post is gone.
 */
function TaskCreatorLine(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly creator: BotThreadSummary | null;
  readonly place: Extract<BotTaskListPlace, { readonly kind: "bot" }>;
}): ReactNode {
  const { botId, hostId, creator, place } = props;
  const anchor = creator?.anchor ?? null;
  if (creator === null || anchor === null) {
    return <span data-testid="bot-task-thread">from a thread</span>;
  }
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={creator.conversationId}
      messageId={anchor.messageId}
      fetchCold={false}
    >
      {(row) => (
        <RowLink
          testId="bot-task-thread"
          onOpen={() =>
            place.onOpenPost({
              anchorMessageId: anchor.messageId,
              announcement: false,
              sent: null,
            })
          }
        >
          from {firstLineOf(postTextOf(row)) ?? "a thread"}
        </RowLink>
      )}
    </ChannelPost>
  );
}

function RowLink(props: {
  readonly onOpen: (() => void) | null;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  if (props.onOpen === null) {
    return (
      <span className="min-w-0 truncate" data-testid={props.testId}>
        {props.children}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onOpen}
      className="min-w-0 truncate text-left hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {props.children}
    </button>
  );
}
