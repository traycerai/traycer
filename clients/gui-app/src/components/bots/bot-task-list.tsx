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
 * Who set a task up, as the owning bot's own lists know it: its trunk, one of
 * its threads (`thread` is `null` while the thread list is not read), or a
 * thread of another bot, which set up an automation on this bot's list. That
 * thread is not this bot's to name or open, and the task is listed here, on
 * the bot that runs it, not in the creating thread's panel.
 */
type BotTaskCreator =
  | { readonly kind: "trunk" }
  | { readonly kind: "thread"; readonly thread: BotThreadSummary | null }
  | { readonly kind: "another-bot" };

function taskCreator(
  task: BotTaskEntry,
  threads: ReadonlyArray<BotThreadSummary> | null,
): BotTaskCreator {
  if (task.createdByChatId === null) return { kind: "trunk" };
  if (threads === null) return { kind: "thread", thread: null };
  const thread = threads.find(
    (listed) => listed.threadId === task.createdByChatId,
  );
  return thread === undefined
    ? { kind: "another-bot" }
    : { kind: "thread", thread };
}

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
  /** The bot's threads, as listed; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
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
            post={taskRequestPost(task, threads ?? [], channelId)}
            creator={taskCreator(task, threads)}
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
  readonly creator: BotTaskCreator;
  readonly place: BotTaskListPlace;
}): ReactNode {
  const { botId, hostId, task, title, post, creator, place } = props;
  const working = useEpicAgentActivity(task.taskId).working.size;
  const navigate = useNavigate();
  const tracking = task.state === "tracking";
  const interval = describeTaskInterval(task);
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
        {place.kind === "bot" ? (
          <BotViewOriginLines
            botId={botId}
            hostId={hostId}
            post={post}
            creator={creator}
            place={place}
          />
        ) : (
          <ThreadPanelRequestLine
            botId={botId}
            hostId={hostId}
            post={post}
            threadId={place.threadId}
          />
        )}
        {task.endedReason === null ? null : <span>{task.endedReason}</span>}
      </span>
    </div>
  );
}

/**
 * Where a task came from, in the bot's view: "for <the post's first line>"
 * for a channel post the channel has loaded, opening its thread (or the box
 * that starts one), and "from <the thread's post>" for the thread that set
 * the task up, opening that thread. The thread is left out only while the
 * post's line is on screen and already opens it. A message inside a thread
 * is named by its thread alone, and a thread of another bot as such, with
 * nothing to open.
 */
function BotViewOriginLines(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly post: BotTaskRequestPost | null;
  readonly creator: BotTaskCreator;
  readonly place: Extract<BotTaskListPlace, { readonly kind: "bot" }>;
}): ReactNode {
  const { botId, hostId, post, creator, place } = props;
  if (creator.kind === "another-bot") {
    return <span data-testid="bot-task-thread">from another bot's thread</span>;
  }
  const creatorLine = (
    <TaskCreatorLine
      botId={botId}
      hostId={hostId}
      creator={creator}
      place={place}
    />
  );
  if (post === null || post.kind === "thread-message") return creatorLine;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={post.chatId}
      messageId={post.messageId}
      fetchCold={false}
    >
      {(row) => {
        const line = firstLineOf(postTextOf(row));
        const opensCreator =
          creator.kind === "thread" &&
          creator.thread !== null &&
          post.thread?.threadId === creator.thread.threadId;
        return (
          <>
            {line === null ? null : (
              <RowLink
                testId="bot-task-request"
                onOpen={() =>
                  place.onOpenPost({
                    anchorMessageId: post.messageId,
                    announcement: post.thread === null,
                    sent: null,
                  })
                }
              >
                for {line}
              </RowLink>
            )}
            {line !== null && opensCreator ? null : creatorLine}
          </>
        );
      }}
    </ChannelPost>
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
          <RowLink onOpen={null} testId="bot-task-request">
            for {line}
          </RowLink>
        );
      }}
    </ChannelPost>
  );
}

/**
 * "from <the thread's post>", opening that thread in the channel; "from a
 * thread" while the list does not have it, or its post is gone or not
 * loaded. Nothing for the trunk's own task.
 */
function TaskCreatorLine(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly creator: Exclude<BotTaskCreator, { readonly kind: "another-bot" }>;
  readonly place: Extract<BotTaskListPlace, { readonly kind: "bot" }>;
}): ReactNode {
  const { botId, hostId, creator, place } = props;
  if (creator.kind === "trunk") return null;
  const thread = creator.thread;
  const anchor = thread?.anchor ?? null;
  if (thread === null || anchor === null) {
    return <span data-testid="bot-task-thread">from a thread</span>;
  }
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={thread.conversationId}
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
