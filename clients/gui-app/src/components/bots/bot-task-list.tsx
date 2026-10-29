import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BotTaskCheckins } from "@/components/bots/bot-task-checkins";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  describeTaskInterval,
  firstLineOf,
  sortTasksForDisplay,
  taskRequestPost,
  threadOpenOf,
  type BotTaskRequestPost,
} from "@/lib/bots/bot-trunk-model";
import { taskKindOf } from "@/lib/bots/bot-activity-model";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import { postTextOf } from "@/lib/bots/reply-row";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import type {
  BotOpenThread,
  BotOpenTurn,
} from "@/stores/bots/bot-open-thread-store";
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
      /** Opens a check-in's turn beside the channel. */
      readonly onOpenTurn: (open: BotOpenTurn) => void;
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
 * A bot's tasks (Tracy Bots T82), one row each: the task's title, what the
 * bot named it, the post it was set up for, the thread that set it up, and
 * an automation's interval. A one-off task shows no interval, and an entry
 * from a host that predates where a task came from shows neither the post
 * nor the thread. In a thread's panel the title opens the task; on the bot's
 * Activity page (T86) the row also names its kind, its next check-in and the
 * host that last reported it, opens the task from "Open the brief", and
 * lists its check-ins under it.
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
  const onBotPage = place.kind === "bot";
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
        <TaskTitle
          title={title ?? task.taskId}
          onOpen={onBotPage ? null : openTask}
        />
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
          <>
            <BotPageTaskFacts task={task} />
            <BotViewOriginLines
              botId={botId}
              hostId={hostId}
              post={post}
              creator={creator}
              place={place}
            />
          </>
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
      {onBotPage ? (
        <>
          <span className="flex">
            <Button
              type="button"
              variant="link"
              size="xs"
              data-testid="bot-task-open"
              onClick={openTask}
            >
              Open the brief
            </Button>
          </span>
          <BotTaskCheckins
            botId={botId}
            hostId={hostId}
            task={task}
            onOpenTurn={place.onOpenTurn}
          />
        </>
      ) : null}
    </div>
  );
}

/** The task's title, opening the task where the row has no "Open the brief". */
function TaskTitle(props: {
  readonly title: string;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  if (props.onOpen === null) {
    return (
      <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
        {props.title}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="bot-task-open"
      className="min-w-0 flex-1 truncate text-left text-ui-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={props.onOpen}
    >
      {props.title}
    </button>
  );
}

/**
 * What the Activity page says of a task beside its interval: its kind in
 * words, an automation's next check-in, and the host whose report its newest
 * check-in was.
 */
function BotPageTaskFacts(props: { readonly task: BotTaskEntry }): ReactNode {
  const { task } = props;
  const reported = task.checkins?.find((record) => record.kind === "received");
  return (
    <>
      <span data-testid="bot-task-kind">{taskKindOf(task)}</span>
      {task.state === "tracking" && task.nextAt !== null ? (
        <span data-testid="bot-task-next" className="tabular-nums">
          next {formatAbsoluteDateTime(task.nextAt)}
        </span>
      ) : null}
      {reported?.kind === "received" ? (
        <span data-testid="bot-task-host">on {reported.hostName}</span>
      ) : null}
    </>
  );
}

/**
 * Where a task came from, in the bot's view: "for <the post's first line>"
 * for a channel post the channel has loaded, opening its thread (or the box
 * that starts one), and "from <the thread's post>" for the thread that set
 * the task up, opening that thread. The thread is left out only while the
 * post's line is on screen and already opens it; then one reader fetches
 * and holds that post for both lines, so the line changing from one to the
 * other neither lets the post go nor reads it again. A message inside a
 * thread is named by its thread alone, and a thread of another bot as such,
 * with nothing to open.
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
  const opensCreator =
    creator.kind === "thread" &&
    creator.thread !== null &&
    post.thread?.threadId === creator.thread.threadId;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={post.chatId}
      messageId={post.messageId}
      fetchCold={opensCreator}
    >
      {(row) => {
        const line = firstLineOf(postTextOf(row));
        const open = row === null ? null : threadOpenOf(row);
        const fromLine = opensCreator ? (
          <CreatorLink
            anchorMessageId={post.messageId}
            row={row}
            place={place}
          />
        ) : (
          creatorLine
        );
        return (
          <>
            {line === null ? null : (
              <RowLink
                testId="bot-task-request"
                onOpen={() =>
                  place.onOpenPost({
                    anchorMessageId: post.messageId,
                    announcement:
                      post.thread === null || open?.announcement === true,
                    answer: open?.answer ?? false,
                    sent: null,
                  })
                }
              >
                for {line}
              </RowLink>
            )}
            {line !== null && opensCreator ? null : fromLine}
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
 * "from <the thread's post>", opening that thread in the channel as the
 * post's own row opens it, an answer's thread through the answer's own gate;
 * "from a thread", with nothing to open, while the list does not have it,
 * its post is gone, or the post is being fetched (which row it is decides
 * how its thread opens). Nothing for the trunk's own task.
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
      fetchCold
    >
      {(row) => (
        <CreatorLink
          anchorMessageId={anchor.messageId}
          row={row}
          place={place}
        />
      )}
    </ChannelPost>
  );
}

/** The "from" line over its thread's post as read: plain until the row is there. */
function CreatorLink(props: {
  readonly anchorMessageId: string;
  readonly row: OpenMessage | null;
  readonly place: Extract<BotTaskListPlace, { readonly kind: "bot" }>;
}): ReactNode {
  const { anchorMessageId, row, place } = props;
  const open = row === null ? null : threadOpenOf(row);
  if (open === null) {
    return <span data-testid="bot-task-thread">from a thread</span>;
  }
  return (
    <RowLink
      testId="bot-task-thread"
      onOpen={() =>
        place.onOpenPost({
          anchorMessageId,
          announcement: open.announcement,
          answer: open.answer,
          sent: null,
        })
      }
    >
      from {firstLineOf(postTextOf(row)) ?? "a thread"}
    </RowLink>
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
