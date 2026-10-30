import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useNavigate } from "@tanstack/react-router";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotActivityTarget,
  BotNotificationDigest,
  BotNotificationSubscription,
  BotSessionActivity,
  BotStoppedNotificationWatch,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { fallbackReasonLabelFor } from "@/components/chat/fallback/fallback-copy";
import { BotTaskList } from "@/components/bots/bot-task-list";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import type { BotActivitySummary } from "@/hooks/bots/use-bot-activity-summary";
import { useBotNotificationsStopMutation } from "@/hooks/bots/use-bot-task-action-mutations";
import { useBotFailedRequest } from "@/hooks/bots/use-bot-failed-request";
import {
  useBotSendFailure,
  type BotSendFailure,
} from "@/hooks/bots/use-bot-send-failure";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  endedReasonWords,
  finishedTasksOf,
  finishedThisWeek,
  producedTicketsOf,
  RECENT_CHECKINS_SHOWN,
  stoppedPostOf,
  trackingTasksOf,
  type BotFinishedTask,
  type BotRunningRow,
  type BotStoppedPost,
  type BotStoppedSession,
} from "@/lib/bots/bot-activity-model";
import {
  describeNotificationWatch,
  firstLineOf,
  threadOpenOf,
} from "@/lib/bots/bot-trunk-model";
import {
  botActivityMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { postTextOf } from "@/lib/bots/reply-row";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { formatAbsoluteDateTime, useSampledNow } from "@/lib/relative-time";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  BotOpenThread,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const EMPTY_STOP_IDS: ReadonlySet<string> = new Set();
const noop = (): void => undefined;
const noStop = (): string | null => null;

/**
 * A bot's Activity page (Tracy Bots T86, decision 115): one page for the
 * bot, across its trunk and every thread, live and of this week. A row is
 * here when the bot started the thing or owns it (`bot-activity-model.ts`),
 * in four sections: what runs now, a stopped answer first; its tasks and
 * automations, each with its check-ins under it; the chats watching the
 * person's notifications; and what finished this week. Nothing else: no
 * conversations, settings or cost.
 */
export function BotActivityPage(props: {
  readonly botId: string;
  readonly hostId: string;
  /** The host that runs the bot, as the stream names it. */
  readonly boundHost: {
    readonly hostId: string | null;
    readonly isThisHost: boolean;
  };
  /** The bot's channel; `null` from a host that does not name it. */
  readonly channelId: string | null;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;
  /** The watches members stopped; `null` from a host that does not say. */
  readonly stoppedNotificationWatches: ReadonlyArray<BotStoppedNotificationWatch> | null;
  /** Names the members who paused, stopped or ran something. */
  readonly resolveMember: BotMemberResolver;
  readonly summary: BotActivitySummary;
  /** The bot's threads, as listed; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  /** Opens a post's thread beside the channel, in Messages. */
  readonly onOpenPost: (open: BotOpenThread) => void;
  /** Opens a check-in's turn: its session, in place of the channel. */
  readonly onOpenTurn: BotTurnOpen;
}): ReactNode {
  const {
    botId,
    hostId,
    boundHost,
    channelId,
    tasks,
    notificationSubscriptions,
    stoppedNotificationWatches,
    resolveMember,
    summary,
    threads,
    onOpenPost,
    onOpenTurn,
  } = props;
  const viewer = useAuthStore((s) => s.profile);
  const userId = viewer?.userId ?? null;
  const nameOf = useCallback(
    (memberId: string): string =>
      botActivityMemberName(memberId, viewer, resolveMember),
    [resolveMember, viewer],
  );
  const taskIds = useMemo(() => tasks.map((task) => task.taskId), [tasks]);
  const contexts = useEpicGetTaskContexts(taskIds, userId, {
    enabled: taskIds.length > 0,
  });
  const titleOf = useCallback(
    (taskId: string): string | null =>
      contexts.tasksById.get(taskId)?.epic?.light?.title ?? null,
    [contexts.tasksById],
  );
  const tracking = useMemo(() => trackingTasksOf(tasks), [tasks]);
  const boundHere = boundHost.isThisHost;
  const place = useMemo(
    () => ({
      kind: "bot" as const,
      channelId,
      onOpenPost,
      onOpenTurn,
      boundHere,
      nameOf,
    }),
    [boundHere, channelId, nameOf, onOpenPost, onOpenTurn],
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4"
      data-testid="bot-activity-page"
    >
      <ActivitySection label="Running now" testId="bot-activity-running">
        {summary.stopped.length === 0 && summary.running.length === 0 ? (
          <EmptyLine text="Nothing running." />
        ) : (
          <ul className="flex flex-col gap-1">
            {summary.stopped.map((stopped) => (
              <li key={stoppedKey(stopped)}>
                <StoppedRow
                  botId={botId}
                  hostId={hostId}
                  boundHostId={boundHost.hostId}
                  channelId={channelId}
                  stopped={stopped}
                  threads={threads}
                  onOpenPost={onOpenPost}
                />
              </li>
            ))}
            {summary.running.map((row) => (
              <li key={runningKey(row)}>
                <RunningRow
                  botId={botId}
                  hostId={hostId}
                  boundHere={boundHost.isThisHost}
                  row={row}
                  threads={threads}
                  titleOf={titleOf}
                />
              </li>
            ))}
          </ul>
        )}
      </ActivitySection>
      <ActivitySection
        label="Tasks and automations"
        testId="bot-activity-tasks"
      >
        {tracking.length === 0 ? (
          <EmptyLine text="No tasks or automations." />
        ) : (
          <BotTaskList
            botId={botId}
            hostId={hostId}
            tasks={tracking}
            threads={threads}
            place={place}
          />
        )}
      </ActivitySection>
      <NotificationsSection
        botId={botId}
        hostId={hostId}
        boundHere={boundHere}
        watches={notificationSubscriptions}
        stopped={stoppedNotificationWatches}
        threads={threads}
        nameOf={nameOf}
      />
      <FinishedSection tasks={tasks} titleOf={titleOf} nameOf={nameOf} />
    </div>
  );
}

function ActivitySection(props: {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-label={props.label}
      className="flex flex-col gap-1"
      data-testid={props.testId}
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        {props.label}
      </h3>
      {props.children}
    </section>
  );
}

function EmptyLine(props: { readonly text: string }): ReactNode {
  return <p className="py-1 text-ui-xs text-muted-foreground">{props.text}</p>;
}

function stoppedKey(stopped: BotStoppedSession): string {
  return stopped.target.kind === "trunk"
    ? "stopped:trunk"
    : `stopped:${stopped.target.threadId}`;
}

function runningKey(row: BotRunningRow): string {
  return row.kind === "task" ? `task:${row.taskId}` : `chat:${row.chatId}`;
}

/** Where a session of the bot answers: the channel, or one of its threads. */
function threadOf(
  target: BotStoppedSession["target"],
  threads: ReadonlyArray<BotThreadSummary> | null,
): BotThreadSummary | null {
  if (target.kind === "trunk") return null;
  return threads?.find((thread) => thread.threadId === target.threadId) ?? null;
}

/**
 * A session of the bot that stopped answering a post: where, why in the
 * agent chat's own words, Retry, which sends the post to the bot again as
 * the post's own Retry does, and Open, which opens the post's thread in
 * Messages, where its Not answered line is.
 */
function StoppedRow(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHostId: string | null;
  readonly channelId: string | null;
  readonly stopped: BotStoppedSession;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, channelId, stopped, threads } = props;
  const failure = useBotSendFailure();
  const post = stoppedPostOf(stopped, threads, channelId);
  const reasonText = stoppedReasonText(stopped.session);
  return (
    <div
      data-testid="bot-activity-stopped"
      className="flex flex-col gap-0.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-ui-xs text-destructive"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <span className="min-w-0 truncate text-foreground">
          {stopped.target.kind === "trunk" ? (
            "In the channel"
          ) : (
            <ThreadName
              botId={botId}
              hostId={hostId}
              thread={threadOf(stopped.target, threads)}
            />
          )}
        </span>
        <span>· stopped</span>
        {reasonText === null ? null : <span>· {reasonText}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {post.sentIn === null ? null : (
          <StoppedRetry
            {...props}
            post={post}
            sentIn={post.sentIn}
            failure={failure}
          />
        )}
        {post.anchor === null ? null : (
          <StoppedOpen
            botId={botId}
            hostId={hostId}
            anchor={post.anchor}
            onOpenPost={props.onOpenPost}
          />
        )}
        {failure.failed ? <span>Couldn't send it again.</span> : null}
      </span>
    </div>
  );
}

/** Why a session stopped, in the agent chat's words; `null` for no reason given. */
function stoppedReasonText(session: BotSessionActivity): string | null {
  const reason = session.reason;
  if (reason === null) return null;
  if (reason.code === null) return reason.summary;
  return fallbackReasonLabelFor(reason.code) ?? reason.summary;
}

/** Retry, once the post's text is read where it was sent. */
function StoppedRetry(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHostId: string | null;
  readonly channelId: string | null;
  readonly stopped: BotStoppedSession;
  readonly post: BotStoppedPost;
  /** The record the post was sent in, whose row holds its text. */
  readonly sentIn: string;
  readonly failure: BotSendFailure;
}): ReactNode {
  const { botId, hostId, boundHostId, channelId, stopped, post, sentIn } =
    props;
  const { failure } = props;
  const client = useTabHostClient();
  const failedOn = useCallback(
    (requestId: string) =>
      requestId === stopped.requestId ? stopped.session : null,
    [stopped],
  );
  const failedRequest = useBotFailedRequest({
    client,
    hostId,
    boundHostId,
    botId,
    conversationId: channelId,
    threadId: post.threadId,
    failedOn,
    onEdit: noop,
    failure,
  });
  const failed = failedRequest(stopped.requestId, null);
  const retry = failed?.retry ?? null;
  if (failed === null || retry === null) return null;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={sentIn}
      messageId={post.messageId}
      fetchCold
    >
      {(row) => {
        const text = postTextOf(row);
        return text === null ? null : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="bot-activity-stopped-retry"
            disabled={failed.retrying}
            onClick={() => retry(text)}
          >
            Retry
          </Button>
        );
      }}
    </ChannelPost>
  );
}

/** Open, once the post the thread hangs off is read. */
function StoppedOpen(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly anchor: NonNullable<BotStoppedPost["anchor"]>;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, anchor, onOpenPost } = props;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={anchor.conversationId}
      messageId={anchor.messageId}
      fetchCold
    >
      {(row) => {
        const open = row === null ? null : threadOpenOf(row);
        if (open === null) return null;
        return (
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="bot-activity-stopped-open"
            onClick={() =>
              onOpenPost({
                anchorMessageId: anchor.messageId,
                announcement: anchor.startsThread || open.announcement,
                anchorKind: open.anchorKind,
                sent: null,
              })
            }
          >
            Open
          </Button>
        );
      }}
    </ChannelPost>
  );
}

/** A thread named by the first line of the post it hangs off. */
function ThreadName(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly thread: BotThreadSummary | null;
}): ReactNode {
  const { botId, hostId, thread } = props;
  const anchor = thread?.anchor ?? null;
  if (thread === null || anchor === null) return "In a thread";
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={thread.conversationId}
      messageId={anchor.messageId}
      fetchCold={false}
    >
      {(row) => {
        const line = firstLineOf(postTextOf(row));
        return line === null ? "In a thread" : `In the thread: ${line}`;
      }}
    </ChannelPost>
  );
}

function RunningRow(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHere: boolean;
  readonly row: BotRunningRow;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly titleOf: (taskId: string) => string | null;
}): ReactNode {
  const { botId, hostId, boundHere, row, threads, titleOf } = props;
  const navigate = useNavigate();
  if (row.kind === "task") {
    const title = titleOf(row.taskId);
    return (
      <div
        data-testid="bot-activity-running-row"
        data-kind="task"
        className="flex min-w-0 flex-wrap items-center gap-x-2 px-2 py-1 text-ui-xs text-muted-foreground"
      >
        <span className="min-w-0 truncate text-ui-sm text-foreground">
          {title ?? row.taskId}
        </span>
        <span>
          {row.agents === 1
            ? "1 agent working"
            : `${row.agents} agents working`}
        </span>
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={() =>
            navigateToTabIntent(
              navigate,
              openEpicFromListIntent({
                epicId: row.taskId,
                focus: undefined,
                name: title ?? undefined,
                replaceEmptyDraftId: null,
              }),
              undefined,
            )
          }
        >
          Open the task
        </Button>
      </div>
    );
  }
  if (row.kind === "agent") {
    return (
      <p
        data-testid="bot-activity-running-row"
        data-kind="agent"
        className="px-2 py-1 text-ui-xs text-muted-foreground"
      >
        An agent the bot started is working
      </p>
    );
  }
  const thread = threadOf(row.target, threads);
  return (
    <div
      data-testid="bot-activity-running-row"
      data-kind="session"
      className="flex flex-col gap-0.5 px-2 py-1 text-ui-xs text-muted-foreground"
    >
      <span>
        <span className="text-foreground">
          {row.target.kind === "trunk" ? (
            "In the channel"
          ) : (
            <ThreadName botId={botId} hostId={hostId} thread={thread} />
          )}
        </span>
        {" · background work running"}
      </span>
      {boundHere ? (
        <SessionBackgroundItems
          botId={botId}
          hostId={hostId}
          chatId={row.chatId}
        />
      ) : null}
    </div>
  );
}

/**
 * The background work of one of the bot's sessions, read-only, from the
 * host that runs the bot: its shells, watches and subagents.
 */
function SessionBackgroundItems(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly chatId: string;
}): ReactNode {
  const { botId, hostId, chatId } = props;
  const handle = useChatSessionHandleForContainer(botId, chatId, hostId, true);
  if (handle === null) return null;
  return (
    <SessionBackgroundItemsBody
      store={handle.store}
      botId={botId}
      chatId={chatId}
    />
  );
}

function SessionBackgroundItemsBody(props: {
  readonly store: ChatSessionStoreHandle["store"];
  readonly botId: string;
  readonly chatId: string;
}): ReactNode {
  const { store, botId, chatId } = props;
  const state = useStore(
    store,
    useShallow((s) => ({
      backgroundItems: s.backgroundItems,
      runStatus: s.runStatus,
    })),
  );
  if (
    state.backgroundItems === undefined ||
    state.backgroundItems.length === 0
  ) {
    return null;
  }
  return (
    <BackgroundItemsPanel
      items={state.backgroundItems}
      epicId={botId}
      chatId={chatId}
      viewTabId={`bot-activity:${chatId}`}
      canAct={false}
      readOnly
      pendingStopTaskIds={EMPTY_STOP_IDS}
      stopAllPending={false}
      sessionStopPending={false}
      turnActive={state.runStatus !== "idle"}
      scrollRegionMaxHeightClass="max-h-72"
      separated={false}
      onItemClick={noop}
      onStopItem={noStop}
      onStopAll={noStop}
      onStopSession={noStop}
    />
  );
}

/**
 * The bot's chats watching the person's notifications (T84): the channel's
 * and each subscribed thread's, what each watches and since when, and the
 * digests each was handed this week. The bot sets these itself; a member
 * can stop one here (T92) where the tab's host runs the bot, and a stopped
 * watch stays listed, with who stopped it, until the chat watches again.
 * Nothing from a host that does not say.
 */
function NotificationsSection(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHere: boolean;
  readonly watches: ReadonlyArray<BotNotificationSubscription> | null;
  readonly stopped: ReadonlyArray<BotStoppedNotificationWatch> | null;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly nameOf: (userId: string) => string;
}): ReactNode {
  const { botId, hostId, boundHere, threads, nameOf } = props;
  const watches = props.watches ?? [];
  const stopped = props.stopped ?? [];
  const client = useTabHostClient();
  const canStop =
    useHostMethodSupport(hostId, "bot.notifications.stop") === true &&
    boundHere;
  const stopWatching = useBotNotificationsStopMutation(client);
  if (watches.length === 0 && stopped.length === 0) return null;
  const where = (target: BotActivityTarget): ReactNode =>
    target.kind === "trunk" ? (
      "In the channel"
    ) : (
      <ThreadName
        botId={botId}
        hostId={hostId}
        thread={threadOf(target, threads)}
      />
    );
  return (
    <ActivitySection label="Notifications" testId="bot-activity-notifications">
      <ul className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
        {watches.map((watch) => {
          const target = watch.target;
          return (
            <li
              key={targetKey(target)}
              className="flex min-w-0 flex-col gap-0.5 px-2"
              data-testid="bot-notification-watch"
            >
              <span className="truncate text-foreground">{where(target)}</span>
              <span>
                {describeNotificationWatch(watch)}
                {watch.since === null
                  ? null
                  : ` · since ${formatAbsoluteDateTime(watch.since)}`}
              </span>
              {canStop ? (
                <span className="flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    data-testid="bot-notification-stop"
                    disabled={stopWatching.isPending}
                    onClick={() => stopWatching.mutate({ botId, target })}
                  >
                    Stop watching
                    {stopWatching.isPending &&
                    targetKey(stopWatching.variables.target) ===
                      targetKey(target) ? (
                      <AgentSpinningDots
                        className={undefined}
                        testId="bot-notification-stop-pending"
                        variant={undefined}
                      />
                    ) : null}
                  </Button>
                </span>
              ) : null}
              <RecentDigests digests={watch.digests ?? []} />
            </li>
          );
        })}
        {stopped.map((watch) => (
          <li
            key={`stopped:${targetKey(watch.target)}`}
            className="flex min-w-0 flex-col gap-0.5 px-2 opacity-70"
            data-testid="bot-notification-watch-stopped"
          >
            <span className="truncate text-foreground">
              {where(watch.target)}
            </span>
            <span>
              Stopped watching your notifications · by{" "}
              {nameOf(watch.stoppedByUserId)} ·{" "}
              {formatAbsoluteDateTime(watch.stoppedAt)}
            </span>
            <RecentDigests digests={watch.digests} />
          </li>
        ))}
      </ul>
    </ActivitySection>
  );
}

function targetKey(target: BotActivityTarget): string {
  return target.kind === "trunk" ? "trunk" : target.threadId;
}

/**
 * The digests a watching chat was handed, newest first: the newest few, and
 * "All N digests" the rest of the week the host keeps.
 */
function RecentDigests(props: {
  readonly digests: ReadonlyArray<BotNotificationDigest>;
}): ReactNode {
  const { digests } = props;
  const [all, setAll] = useState(false);
  if (digests.length === 0) return null;
  const shown = all ? digests : digests.slice(0, RECENT_CHECKINS_SHOWN);
  return (
    <section
      aria-label="Recent digests"
      className="flex flex-col gap-0.5 border-l border-border/60 pl-2"
      data-testid="bot-notification-digests"
    >
      <ul className="flex flex-col gap-0.5">
        {shown.map((digest) => (
          <li
            key={digest.queueItemId}
            data-testid="bot-notification-digest"
            className="tabular-nums"
          >
            {formatAbsoluteDateTime(digest.deliveredAt)} ·{" "}
            {describeDigest(digest)}
          </li>
        ))}
      </ul>
      {digests.length > RECENT_CHECKINS_SHOWN ? (
        <span className="flex">
          <Button
            type="button"
            variant="link"
            size="xs"
            data-testid="bot-notification-digests-all"
            aria-expanded={all}
            onClick={() => setAll((open) => !open)}
          >
            {all ? "Fewer digests" : `All ${digests.length} digests`}
          </Button>
        </span>
      ) : null}
    </section>
  );
}

function describeDigest(digest: BotNotificationDigest): string {
  const items =
    digest.itemCount === 1
      ? "1 notification"
      : `${digest.itemCount} notifications`;
  return digest.attentionCount === 0
    ? items
    : `${items}, ${digest.attentionCount} needing you`;
}

/**
 * The tasks the bot no longer runs that ended this week, with what they
 * produced, and "All finished work" for every one the bot lists. A task's
 * end is its latest check-in; one with none is in the full list only.
 */
function FinishedSection(props: {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly titleOf: (taskId: string) => string | null;
  readonly nameOf: (userId: string) => string;
}): ReactNode {
  const { tasks, titleOf, nameOf } = props;
  const now = useSampledNow();
  const [all, setAll] = useState(false);
  const finished = useMemo(() => finishedTasksOf(tasks), [tasks]);
  const week = useMemo(() => finishedThisWeek(finished, now), [finished, now]);
  const shown = all ? finished : week;
  return (
    <ActivitySection label="Finished" testId="bot-activity-finished">
      {shown.length === 0 ? (
        <EmptyLine text="Nothing finished this week." />
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((entry) => (
            <li key={entry.task.taskId}>
              <FinishedRow
                entry={entry}
                title={titleOf(entry.task.taskId)}
                nameOf={nameOf}
              />
            </li>
          ))}
        </ul>
      )}
      {finished.length > week.length ? (
        <span className="flex">
          <Button
            type="button"
            variant="link"
            size="xs"
            data-testid="bot-activity-finished-all"
            aria-expanded={all}
            onClick={() => setAll((open) => !open)}
          >
            {all ? "This week only" : `All finished work (${finished.length})`}
          </Button>
        </span>
      ) : null}
    </ActivitySection>
  );
}

function FinishedRow(props: {
  readonly entry: BotFinishedTask;
  readonly title: string | null;
  readonly nameOf: (userId: string) => string;
}): ReactNode {
  const { entry, title, nameOf } = props;
  const { task } = entry;
  const navigate = useNavigate();
  const produced = producedTicketsOf(task);
  return (
    <div
      data-testid="bot-activity-finished-row"
      data-task-id={task.taskId}
      className="flex flex-col gap-0.5 px-2 py-1 text-ui-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate text-ui-sm text-foreground">
        {title ?? task.taskId}
      </span>
      <span className="flex flex-wrap gap-x-2">
        <span data-testid="bot-activity-finished-reason">
          {task.stop === null
            ? endedReasonWords(task)
            : `Stopped by ${nameOf(task.stop.byUserId)}`}
        </span>
        {entry.endedAt === null ? null : (
          <span className="tabular-nums">
            {formatAbsoluteDateTime(entry.endedAt)}
          </span>
        )}
        {produced.length === 0 ? null : (
          <span data-testid="bot-activity-finished-produced">
            closed {produced.join(", ")}
          </span>
        )}
      </span>
      <span className="flex">
        <Button
          type="button"
          variant="link"
          size="xs"
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
          Open the brief
        </Button>
      </span>
    </div>
  );
}
