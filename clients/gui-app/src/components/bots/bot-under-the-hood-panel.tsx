import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { postTextOf } from "@/lib/bots/reply-row";
import { BotSessionsElsewhere } from "@/components/bots/bot-sessions-elsewhere";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import {
  useBotCostsQuery,
  type BotCosts,
  type BotCostsEnvironmentBot,
} from "@/hooks/bots/use-bot-costs-query";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import {
  deliveredTaskCheckins,
  describeCadence,
  pendingTaskCheckins,
  pendingTaskOverdue,
  sortTasksForDisplay,
} from "@/lib/bots/bot-trunk-model";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  formatCompactRelativeTime,
  formatWaitTime,
  useSampledNow,
} from "@/lib/relative-time";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { cn } from "@/lib/utils";

const EMPTY_TASK_IDS: ReadonlyArray<string> = [];
const EMPTY_THREADS: ReadonlyArray<BotThreadSummary> = [];
const EMPTY_STOP_IDS: ReadonlySet<string> = new Set();
const noop = (): void => undefined;
const noStop = (): string | null => null;

/**
 * What the bot is doing (Tracy Bots): what it and its environment have
 * cost, its threads, the tasks it tracks and when each checks in, the
 * check-ins waiting on its queue, the ones it has already read, the
 * background work its trunk is running, and the transcript of the trunk or
 * of a thread's session - the existing chat view, read-only, with no
 * composer: a person talks to the bot in its channel, never on a session.
 *
 * The trunk and the thread sessions are the bot's running chats, so only
 * the host that runs the bot shows them and the trunk's check-ins; on any
 * other host they say where they are, and offer to move the tab there when
 * this app can connect to it (Tracy Bots T65). Every host lists the threads.
 */
export function BotUnderTheHoodPanel(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly trunkChatId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** The stream's open-request hint; `null` is unknown and renders nothing. */
  readonly openRequestCount: number | null;
  /** The host that runs the bot, as the stream names it. */
  readonly boundHost: {
    readonly hostId: string | null;
    readonly isThisHost: boolean;
  };
  /** The bot's environment, named on its cost line, and every bot in it
   * (`null` while the bot list is not read). */
  readonly environmentLabel: string;
  readonly environmentBots: ReadonlyArray<BotCostsEnvironmentBot> | null;
  /** The thread session whose transcript is shown; `null` shows the trunk. */
  readonly sessionChatId: string | null;
  readonly onSelectSession: (sessionChatId: string | null) => void;
}): ReactNode {
  const {
    botId,
    hostId,
    botTitle,
    trunkChatId,
    tasks,
    openRequestCount,
    boundHost,
    environmentLabel,
    environmentBots,
    sessionChatId,
    onSelectSession,
  } = props;
  const client = useTabHostClient();
  // Any host with the list lists the threads.
  const threadListSupported =
    useHostMethodSupport(hostId, "bot.thread.list") === true;
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: threadListSupported,
  });
  const threads = threadList.data?.threads ?? EMPTY_THREADS;
  const shownThread =
    sessionChatId === null
      ? null
      : (threads.find((thread) => thread.sessionChatId === sessionChatId) ??
        null);
  const usageSupported = useUsageSummarySupported(hostId);
  const costs = useBotCostsQuery(client, {
    botId,
    hostId,
    threadList: threadList.data,
    environmentBots,
    enabled: usageSupported && threadListSupported,
  });
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:grid-rows-1">
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-border/60 p-4 @3xl:border-r @3xl:border-b-0">
          {usageSupported ? (
            <BotCostSection costs={costs} environmentLabel={environmentLabel} />
          ) : null}
          {threadListSupported ? (
            <BotThreadsList
              botId={botId}
              hostId={hostId}
              threadList={threadList}
              sessionChatId={sessionChatId}
              onSelectSession={onSelectSession}
            />
          ) : null}
          <BotTasksList tasks={tasks} />
          {!boundHost.isThisHost ? null : (
            <BotTrunkState
              botId={botId}
              hostId={hostId}
              trunkChatId={trunkChatId}
              openRequestCount={openRequestCount}
            />
          )}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1">
            <h3
              className="min-w-0 flex-1 truncate text-ui-xs tracking-[0.08em] text-muted-foreground uppercase"
              data-testid="bot-session-heading"
            >
              {shownThread === null ? (
                "Trunk"
              ) : (
                <ThreadExcerpt
                  botId={botId}
                  hostId={hostId}
                  thread={shownThread}
                  prefix="Thread: "
                  fetchCold
                />
              )}
            </h3>
            {sessionChatId === null ? null : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onSelectSession(null)}
              >
                Show trunk
              </Button>
            )}
          </div>
          {!boundHost.isThisHost ? (
            <SessionsElsewhere botId={botId} boundHostId={boundHost.hostId} />
          ) : (
            <BotChatTranscript
              key={sessionChatId ?? undefined}
              botId={botId}
              chatId={sessionChatId ?? trunkChatId}
              hostId={hostId}
              title={botTitle}
              instanceId={
                sessionChatId === null
                  ? `bot-trunk:${botId}`
                  : `bot-thread-session:${sessionChatId}`
              }
              surface={null}
              resolveMember={UNRESOLVED_BOT_MEMBERS}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the bot's running chats are, and a move of the tab there when this
 * app can connect to that host.
 */
function SessionsElsewhere(props: {
  readonly botId: string;
  readonly boundHostId: string | null;
}): ReactNode {
  const { botId, boundHostId } = props;
  const connectable = useConnectableHostIds();
  const rebindBotTab = useBotTabsStore((s) => s.rebindBotTab);
  const dialable =
    boundHostId !== null &&
    connectable.resolved &&
    connectable.hostIds.includes(boundHostId);
  return (
    <BotSessionsElsewhere
      onOpenThere={dialable ? () => rebindBotTab(botId, boundHostId) : null}
    />
  );
}

/**
 * A thread named by the start of the post it answers, read from the
 * channel's row: a summary carries no post text. The shown session's
 * heading fetches an old post's row; a row of the list names the thread
 * from what the channel has loaded.
 */
function ThreadExcerpt(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly thread: BotThreadSummary;
  readonly prefix: string;
  readonly fetchCold: boolean;
}): ReactNode {
  const { botId, hostId, thread, prefix, fetchCold } = props;
  if (thread.anchor === null) return `${prefix}Thread`;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={thread.conversationId}
      messageId={thread.anchor.messageId}
      fetchCold={fetchCold}
    >
      {(post) => `${prefix}${threadExcerpt(postTextOf(post))}`}
    </ChannelPost>
  );
}

function threadExcerpt(post: string | null): string {
  const text = post?.trim() ?? "";
  if (text.length === 0) return "Thread";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * What the bot has cost and what its environment's bots have, every
 * member's turns; no figure per person (decision 43).
 */
function BotCostSection(props: {
  readonly costs: BotCosts;
  readonly environmentLabel: string;
}): ReactNode {
  const { costs, environmentLabel } = props;
  return (
    <section
      aria-label="Cost"
      className="flex flex-col gap-1"
      data-testid="bot-costs"
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        Cost
      </h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-ui-sm">
        <CostRow label="This bot" usd={costs.botUsd} testId="bot-cost-bot" />
        <CostRow label="Trunk" usd={costs.trunkUsd} testId="bot-cost-trunk" />
        <CostRow
          label={environmentLabel}
          usd={costs.environmentUsd}
          testId="bot-cost-environment"
        />
      </dl>
    </section>
  );
}

function CostRow(props: {
  readonly label: string;
  readonly usd: number | null;
  readonly testId: string;
}): ReactNode {
  return (
    <>
      <dt className="truncate text-muted-foreground">{props.label}</dt>
      <dd
        className="text-right tabular-nums text-foreground"
        data-testid={props.testId}
      >
        {props.usd === null ? "—" : formatUsd(props.usd)}
      </dd>
    </>
  );
}

/**
 * The bot's threads, most recent first: the post each answers, its replies
 * and its cost when known. Choosing one shows its session's transcript.
 */
function BotThreadsList(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadList: UseQueryResult<BotThreadListResponse, HostRpcError>;
  readonly sessionChatId: string | null;
  readonly onSelectSession: (sessionChatId: string) => void;
}): ReactNode {
  return (
    <section
      aria-label="Threads"
      className="flex flex-col gap-1"
      data-testid="bot-threads"
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        Threads
      </h3>
      <BotThreadsListBody {...props} />
    </section>
  );
}

/** The list once it has answered, and what stands in until it has. */
function BotThreadsListBody(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadList: UseQueryResult<BotThreadListResponse, HostRpcError>;
  readonly sessionChatId: string | null;
  readonly onSelectSession: (sessionChatId: string) => void;
}): ReactNode {
  const { botId, hostId, threadList, sessionChatId, onSelectSession } = props;
  const threads = threadList.data?.threads;
  if (threads === undefined) {
    if (threadList.isError) {
      return (
        <BotReadFailure
          message="Couldn't load the threads."
          onRetry={() => void threadList.refetch()}
          testId="bot-threads-error"
        />
      );
    }
    return (
      <div
        className="py-1 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-threads-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (threads.length === 0) {
    return (
      <p className="py-1 text-ui-xs text-muted-foreground">No threads yet.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {threads.map((thread) => (
        <li key={thread.threadId}>
          <button
            type="button"
            data-testid="bot-thread-row"
            data-session-chat-id={thread.sessionChatId}
            aria-current={
              thread.sessionChatId === sessionChatId ? "true" : undefined
            }
            onClick={() => onSelectSession(thread.sessionChatId)}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
              thread.sessionChatId === sessionChatId && "bg-foreground/6",
            )}
          >
            <span className="truncate text-ui-sm text-foreground">
              <ThreadExcerpt
                botId={botId}
                hostId={hostId}
                thread={thread}
                prefix=""
                fetchCold={false}
              />
            </span>
            <span className="flex flex-wrap gap-x-2 text-ui-xs text-muted-foreground">
              <span>
                {thread.replyCount === 1
                  ? "1 reply"
                  : `${thread.replyCount} replies`}
              </span>
              {thread.costUsd === null ? null : (
                <span
                  className="tabular-nums"
                  data-testid="bot-thread-row-cost"
                >
                  {formatUsd(thread.costUsd)}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function BotTasksList(props: {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
}): ReactNode {
  const { tasks } = props;
  const userId = useAuthStore((s) => s.profile?.userId ?? null);
  const taskIds = useMemo(
    () => (tasks.length === 0 ? EMPTY_TASK_IDS : tasks.map((t) => t.taskId)),
    [tasks],
  );
  const contexts = useEpicGetTaskContexts(taskIds, userId, {
    enabled: taskIds.length > 0,
  });
  const sorted = useMemo(() => sortTasksForDisplay(tasks), [tasks]);
  const now = useSampledNow();
  return (
    <section
      aria-label="Tasks"
      className="flex flex-col gap-1"
      data-testid="bot-tasks"
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        Tasks
      </h3>
      {sorted.length === 0 ? (
        <p className="py-1 text-ui-xs text-muted-foreground">
          Not tracking any task yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sorted.map((task) => (
            <li key={task.taskId}>
              <BotTaskRow
                task={task}
                title={
                  contexts.tasksById.get(task.taskId)?.epic?.light?.title ??
                  null
                }
                now={now}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BotTaskRow(props: {
  readonly task: BotTaskEntry;
  readonly title: string | null;
  readonly now: number;
}): ReactNode {
  const { task, title, now } = props;
  const working = useEpicAgentActivity(task.taskId).working.size;
  const navigate = useNavigate();
  const tracking = task.state === "tracking";
  return (
    <button
      type="button"
      data-testid="bot-task-row"
      data-task-id={task.taskId}
      data-task-state={task.state}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        !tracking && "opacity-70",
      )}
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
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          {title ?? task.taskId}
        </span>
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
      <span className="flex flex-wrap gap-x-2 text-ui-xs text-muted-foreground">
        <span>Check-ins {describeCadence(task.cadence)}</span>
        {task.nextAt === null ? null : (
          <span>next {formatWaitTime(task.nextAt, now)}</span>
        )}
        {task.lastCheckinAt === null ? null : (
          <span>last {ago(task.lastCheckinAt, now)}</span>
        )}
        {task.endedReason === null ? null : <span>{task.endedReason}</span>}
      </span>
    </button>
  );
}

function ago(timestamp: number, now: number): string {
  const compact = formatCompactRelativeTime(timestamp, now);
  return compact === "now" ? "just now" : `${compact} ago`;
}

function BotTrunkState(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly trunkChatId: string;
  readonly openRequestCount: number | null;
}): ReactNode {
  const { botId, hostId, trunkChatId, openRequestCount } = props;
  const handle = useChatSessionHandleForContainer(
    botId,
    trunkChatId,
    hostId,
    true,
  );
  if (handle === null) return null;
  return (
    <BotTrunkStateBody
      store={handle.store}
      botId={botId}
      trunkChatId={trunkChatId}
      openRequestCount={openRequestCount}
    />
  );
}

function BotTrunkStateBody(props: {
  readonly store: ChatSessionStoreHandle["store"];
  readonly botId: string;
  readonly trunkChatId: string;
  readonly openRequestCount: number | null;
}): ReactNode {
  const { store, botId, trunkChatId, openRequestCount } = props;
  const state = useStore(
    store,
    useShallow((s) => ({
      queueItems: s.queue.items,
      messages: s.messages,
      backgroundItems: s.backgroundItems,
      runStatus: s.runStatus,
    })),
  );
  const pending = useMemo(
    () => pendingTaskCheckins(state.queueItems),
    [state.queueItems],
  );
  const overdue = useMemo(
    () => pendingTaskOverdue(state.queueItems),
    [state.queueItems],
  );
  const delivered = useMemo(
    () => deliveredTaskCheckins(state.messages),
    [state.messages],
  );
  const now = useSampledNow();
  const recentDelivered = delivered.slice(-5).reverse();
  return (
    <>
      <section
        aria-label="Check-ins"
        className="flex flex-col gap-1"
        data-testid="bot-checkins"
      >
        <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
          Check-ins
        </h3>
        {openRequestCount !== null && openRequestCount > 0 ? (
          <p className="text-ui-xs text-muted-foreground">
            {openRequestCount === 1
              ? "1 request in the channel is still open."
              : `${openRequestCount} requests in the channel are still open.`}
          </p>
        ) : null}
        {overdue === null ? null : (
          <p
            className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-ui-xs text-warning-foreground"
            data-testid="bot-checkins-overdue"
          >
            <span className="font-medium">Overdue:</span> {overdue.description}.
            The bot is told on its next turn.
          </p>
        )}
        {pending.length === 0 ? null : (
          <ul
            className="flex flex-col gap-1"
            data-testid="bot-checkins-pending"
          >
            {pending.map((item) => (
              <li
                key={item.queueItemId}
                className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-ui-xs text-warning-foreground"
              >
                <span className="font-medium">Waiting for the bot:</span>{" "}
                {item.description}
              </li>
            ))}
          </ul>
        )}
        {recentDelivered.length === 0 &&
        pending.length === 0 &&
        overdue === null ? (
          <p className="py-1 text-ui-xs text-muted-foreground">
            No check-ins yet.
          </p>
        ) : null}
        {recentDelivered.length === 0 ? null : (
          <ul
            className="flex flex-col gap-1"
            data-testid="bot-checkins-delivered"
          >
            {recentDelivered.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-ui-xs"
              >
                <span className="text-muted-foreground">
                  {ago(entry.at, now)}
                </span>
                <span className="text-foreground">{entry.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {state.backgroundItems === undefined ||
      state.backgroundItems.length === 0 ? null : (
        <section aria-label="Background work" data-testid="bot-background">
          <BackgroundItemsPanel
            items={state.backgroundItems}
            epicId={botId}
            chatId={trunkChatId}
            viewTabId={`bot-trunk:${botId}`}
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
        </section>
      )}
    </>
  );
}
