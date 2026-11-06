import {
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, EllipsisVertical } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotInputNeeded,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NestedChatStatusGlyph } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { revealArchiveHiddenIds } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  chatDescendantKind,
  chatDescendantStatusRollup,
  chatStatusRollupWords,
  ownChatStatusKind,
  type ChatDescendantStatusKind,
  type ChatDescendantStatusRollup,
} from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import { useChatRowOpenRef } from "@/components/epic-canvas/sidebar/use-chat-row-open-ref";
import { BotTaskControls } from "@/components/bots/bot-task-actions";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { ChatIndicatorHostScopes } from "@/components/notifications/chat-indicator-host-scopes";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import type { BotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import {
  useBotTaskAgents,
  type BotTaskAgentNode,
  type BotTaskAgents,
} from "@/hooks/bots/use-bot-task-agents";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  agentActivityTiers,
  type AgentActivityTier,
} from "@/lib/agent-activity";
import {
  isPeriodicTask,
  type BotActiveTask,
} from "@/lib/bots/bot-activity-model";
import {
  botActivityMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { describeTaskInterval, firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import { displayTitle } from "@/lib/display-title";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { chatIndicatorHostScopes } from "@/lib/notifications/chat-indicator-scopes";
import { useRegisteredEpicLiveAgents } from "@/lib/epic-selectors";
import {
  formatAbsoluteDateTime,
  useRelativeTimestamp,
} from "@/lib/relative-time";
import {
  activateTabIntent,
  navigateToTabIntent,
  resourceEpicTabIntent,
} from "@/lib/tab-navigation";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import { cn } from "@/lib/utils";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useChatTranscriptJumpStore } from "@/stores/chats/chat-transcript-jump-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  selectNotificationIndicatorState,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

const NO_WAITING: ReadonlyArray<BotInputNeeded> = [];
const NO_FOCUS = {
  focusedAt: undefined,
  focusArtifactId: undefined,
  focusThreadId: undefined,
  migrationSource: undefined,
};

/**
 * A bot's Activity page (Tracy Bots, decision 182): one list of the tasks
 * the bot started, across its trunk and every thread, while anything is
 * still going on in them (`activeTasksOf`). A row is drawn as the Chats
 * panel draws a parent: its status rolled up from the task's agents, its
 * title and badges, what it is doing in words, and, where this window holds
 * the task's session, its agents folded under a chevron.
 */
export function BotActivityPage(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  /** Whether the tab's host is the one running the bot. */
  readonly boundHere: boolean;
  readonly active: BotActiveTasks;
  /** Names the members who paused or ran something. */
  readonly resolveMember: BotMemberResolver;
  /** The bot's threads, as listed; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
}): ReactNode {
  const { botId, hostId, botTitle, boundHere, active, resolveMember } = props;
  const viewer = useAuthStore((s) => s.profile);
  const nameOf = useCallback(
    (memberId: string): string =>
      botActivityMemberName(memberId, viewer, resolveMember),
    [resolveMember, viewer],
  );
  const taskIds = useMemo(
    () => active.rows.map((row) => row.task.taskId),
    [active.rows],
  );
  const contexts = useEpicGetTaskContexts(taskIds, viewer?.userId ?? null, {
    enabled: taskIds.length > 0,
  });
  const heading = `Tasks ${botTitle} started`;
  return (
    <section
      aria-label={heading}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-4"
      data-testid="bot-activity-page"
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        {heading}
      </h3>
      {active.rows.length === 0 ? (
        <p
          className="py-1 text-ui-xs text-muted-foreground"
          data-testid="bot-activity-empty"
        >
          A task leaves this list once nothing in it is running, nothing waits
          on you and you have seen its result. History keeps every task.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {active.rows.map((entry) => (
            <li key={entry.task.taskId}>
              <ActiveTaskRow
                botId={botId}
                hostId={hostId}
                boundHere={boundHere}
                nameOf={nameOf}
                entry={entry}
                indicator={active.indicatorOf(entry.task.taskId)}
                title={
                  contexts.tasksById.get(entry.task.taskId)?.epic?.light
                    ?.title ?? null
                }
                threads={props.threads}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One agent the row's glyph rolls up, with what it holds unread or pending. */
type TaskAgentState = {
  readonly id: string;
  readonly indicator: NotificationIndicatorState;
};

/**
 * The row's glyph: the task's agents on the Chats panel's ladder, through
 * the panel's own fold. The agents are the ones this window's session for the
 * task names, and, session or not, the ones the activity plane reports
 * working and the ones a surface waits on. What the task holds unread that
 * no such agent accounts for is one more done or failure.
 */
function taskRollup(input: {
  readonly agents: ReadonlyArray<TaskAgentState>;
  readonly tiers: ReadonlyMap<string, AgentActivityTier>;
  readonly inputNeeded: ReadonlyArray<BotInputNeeded>;
  readonly aggregate: NotificationIndicatorState;
}): ChatDescendantStatusRollup | null {
  const states = new Map(
    input.agents.map((agent) => [agent.id, agent.indicator]),
  );
  for (const id of input.tiers.keys()) {
    if (!states.has(id)) states.set(id, EMPTY_NOTIFICATION_INDICATOR_STATE);
  }
  for (const waiting of input.inputNeeded) {
    if (!states.has(waiting.agentChatId)) {
      states.set(waiting.agentChatId, EMPTY_NOTIFICATION_INDICATOR_STATE);
    }
  }
  const kinds: Array<ChatDescendantStatusKind | null> = [];
  for (const [id, state] of states) {
    kinds.push(
      chatDescendantKind(
        withSurfaces(state, input.inputNeeded, id),
        input.tiers.get(id),
      ),
    );
  }
  const known = [...states.values()];
  if (
    input.aggregate.unreadFailure &&
    !known.some((state) => state.unreadFailure)
  ) {
    kinds.push("failure");
  }
  if (input.aggregate.unreadDone && !known.some((state) => state.unreadDone)) {
    kinds.push("done");
  }
  return chatDescendantStatusRollup(kinds);
}

/** An agent's state with the surfaces that wait on a person for it. */
function withSurfaces(
  state: NotificationIndicatorState,
  inputNeeded: ReadonlyArray<BotInputNeeded>,
  chatId: string,
): NotificationIndicatorState {
  const asked = inputNeeded.filter((waiting) => waiting.agentChatId === chatId);
  if (asked.length === 0) return state;
  return {
    ...state,
    pendingApproval:
      state.pendingApproval ||
      asked.some((waiting) => waiting.surface.kind === "approval"),
    pendingInterview:
      state.pendingInterview ||
      asked.some((waiting) => waiting.surface.kind !== "approval"),
  };
}

type ActiveTaskRowProps = {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHere: boolean;
  readonly nameOf: (userId: string) => string;
  readonly entry: BotActiveTask;
  /** What the task's agents hold unread, together. */
  readonly indicator: NotificationIndicatorState;
  readonly title: string | null;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
};

/**
 * A task's row under its agents' indicators, each asked of the host that owns
 * the agent, as the Chats panel asks: one host answers only for its own
 * agents, and a task's agents can run on several.
 */
function ActiveTaskRow(props: ActiveTaskRowProps): ReactNode {
  const taskId = props.entry.task.taskId;
  const agents = useBotTaskAgents(taskId);
  const scopes = useMemo(
    () =>
      chatIndicatorHostScopes(
        (agents?.nodes ?? []).map((node) => ({
          chatId: node.id,
          hostId: agentHostOf(node, agents),
        })),
      ),
    [agents],
  );
  const chatEpicIds = useMemo(
    () =>
      Object.fromEntries(
        (agents?.nodes ?? []).map((node) => [node.id, taskId]),
      ),
    [agents, taskId],
  );
  return (
    <ChatIndicatorHostScopes scopes={scopes} chatEpicIds={chatEpicIds}>
      <ActiveTaskRowBody {...props} agents={agents} />
    </ChatIndicatorHostScopes>
  );
}

/** The host owning an agent, else the one serving the task's session. */
function agentHostOf(
  node: BotTaskAgentNode,
  agents: BotTaskAgents | null,
): string {
  return node.ownerHostId ?? agents?.sessionHostId ?? UNKNOWN_HOST_PLACEHOLDER;
}

function ActiveTaskRowBody(
  props: ActiveTaskRowProps & { readonly agents: BotTaskAgents | null },
): ReactNode {
  const { botId, hostId, boundHere, nameOf, entry, indicator, agents } = props;
  const { task } = entry;
  const taskId = task.taskId;
  const inputNeeded = task.inputNeeded ?? NO_WAITING;
  const tiers = agentActivityTiers(useEpicAgentActivity(taskId));
  const agentStates = useTaskAgentStates(taskId, agents);
  const rollup = useMemo(
    () =>
      taskRollup({
        agents: agentStates,
        tiers,
        inputNeeded,
        aggregate: indicator,
      }),
    [agentStates, indicator, inputNeeded, tiers],
  );
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const openTask = (): void =>
    navigateToTabIntent(
      navigate,
      openEpicFromListIntent({
        epicId: taskId,
        focus: undefined,
        name: props.title ?? undefined,
        replaceEmptyDraftId: null,
      }),
      undefined,
    );
  return (
    <div
      data-testid="bot-activity-task"
      data-task-id={taskId}
      data-band={entry.band}
      className="flex flex-col gap-0.5"
    >
      <div className="flex min-w-0 items-start gap-1">
        {agents === null ? (
          <span aria-hidden className="size-6 shrink-0" />
        ) : (
          <button
            type="button"
            aria-label={expanded ? "Hide agents" : "Show agents"}
            aria-expanded={expanded}
            data-testid="bot-activity-task-chevron"
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/6 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
        )}
        <button
          type="button"
          data-testid="bot-activity-task-open"
          onClick={openTask}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-1 py-1 text-left hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TaskRowSummary
            botId={botId}
            hostId={hostId}
            entry={entry}
            title={props.title}
            rollup={rollup}
            agentsReadable={agents !== null}
            threads={props.threads}
          />
        </button>
        <TaskMenu onOpen={openTask} />
      </div>
      <div className="flex flex-col gap-0.5 pl-7.5">
        <BotTaskControls
          botId={botId}
          hostId={hostId}
          task={task}
          boundHere={boundHere}
          nameOf={nameOf}
        />
      </div>
      {expanded && agents !== null ? (
        <TaskAgentRows
          taskId={taskId}
          agents={agents}
          agentStates={agentStates}
          tiers={tiers}
          inputNeeded={inputNeeded}
        />
      ) : null}
    </div>
  );
}

/**
 * What each agent this window's session names for the task holds unread or
 * pending, as its owning host answers (the row's `ChatIndicatorHostScopes`);
 * none for a cold task.
 */
function useTaskAgentStates(
  taskId: string,
  agents: BotTaskAgents | null,
): ReadonlyArray<TaskAgentState> {
  const chatIndicators = useContext(NotificationIndicatorsContext);
  const localRows = useAppLocalNotificationsStore((state) => state.byId);
  return useMemo(
    () =>
      (agents?.nodes ?? []).map((node) => ({
        id: node.id,
        indicator: selectNotificationIndicatorState(
          { byId: localRows },
          { epicId: taskId, chatId: node.id },
          agentHostOf(node, agents),
          chatIndicators,
        ),
      })),
    [agents, chatIndicators, localRows, taskId],
  );
}

/**
 * The row as the Chats panel draws a parent: the rolled-up glyph, named by
 * its per-tier counts as the panel's collapsed parent is, the task's title
 * and badges, what the bot named it, and the second line: the winning
 * state in words, a periodic task's next check-in, whether its agents' host
 * is offline, and the thread that started it.
 */
function TaskRowSummary(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly entry: BotActiveTask;
  readonly title: string | null;
  readonly rollup: ChatDescendantStatusRollup | null;
  /** Whether this window holds the task's session, which names its agents. */
  readonly agentsReadable: boolean;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
}): ReactNode {
  const { entry, rollup } = props;
  const { task } = entry;
  const inputNeeded = task.inputNeeded ?? NO_WAITING;
  const interval = describeTaskInterval(task);
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {rollup === null ? (
          <span
            aria-hidden
            className="size-3.5 shrink-0"
            data-testid="bot-activity-task-glyph"
            data-kind="none"
          />
        ) : (
          <span
            role="img"
            aria-label={chatStatusRollupWords(rollup)}
            className="inline-flex size-3.5 shrink-0 items-center justify-center"
            data-testid="bot-activity-task-glyph"
            data-kind={rollup.kind}
          >
            <NestedChatStatusGlyph kind={rollup.kind} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          {displayTitle(props.title ?? "", "epic")}
        </span>
        {interval === null ? null : (
          <Badge variant="muted" size="xs" data-testid="bot-activity-every">
            {interval}
          </Badge>
        )}
        {inputNeeded.length === 0 ? null : (
          <Badge
            variant="warning"
            size="xs"
            data-testid="bot-activity-needs-you"
          >
            Needs you
          </Badge>
        )}
      </span>
      {task.label === null ? null : (
        <span className="truncate pl-5.5 text-ui-xs text-foreground">
          {task.label}
        </span>
      )}
      <span
        className="flex min-w-0 flex-wrap gap-x-1.5 pl-5.5 text-ui-xs text-muted-foreground"
        data-testid="bot-activity-task-line"
      >
        <TaskStateWords
          rollup={rollup}
          entry={entry}
          waiting={newestWaiting(inputNeeded)}
        />
        {isPeriodicTask(task) && task.nextAt !== null ? (
          <span className="tabular-nums">
            next check-in {formatAbsoluteDateTime(task.nextAt)}
          </span>
        ) : null}
        {props.agentsReadable ? null : <TaskHostOffline task={task} />}
        <FromThread
          botId={props.botId}
          hostId={props.hostId}
          task={task}
          threads={props.threads}
        />
      </span>
    </>
  );
}

/** The surface most recently reported waiting on a person. */
function newestWaiting(
  inputNeeded: ReadonlyArray<BotInputNeeded>,
): BotInputNeeded | null {
  let newest: BotInputNeeded | null = null;
  for (const waiting of inputNeeded) {
    if (newest === null || waiting.reportedAt > newest.reportedAt) {
      newest = waiting;
    }
  }
  return newest;
}

/** What a surface asks of the person, in a few words. */
function surfaceWords(waiting: BotInputNeeded): string | null {
  const surface = waiting.surface;
  switch (surface.kind) {
    case "approval":
      return `approve ${firstLineOf(surface.summary) ?? surface.tool}`;
    case "question":
      return firstLineOf(surface.questions[0]?.text ?? null);
    case "browser":
      return firstLineOf(surface.reason);
  }
}

function agentsWorking(count: number): string {
  return count === 1 ? "1 agent working" : `${count} agents working`;
}

/**
 * The rollup's winning state in words, with its age where one is known:
 * what waits on the person and since when, how many agents work, or when the
 * task's result came in. Nothing for a periodic task with nothing going on.
 */
function TaskStateWords(props: {
  readonly rollup: ChatDescendantStatusRollup | null;
  readonly entry: BotActiveTask;
  readonly waiting: BotInputNeeded | null;
}): ReactNode {
  const { rollup, entry, waiting } = props;
  if (rollup === null) return null;
  const working = Math.max(
    entry.working,
    rollup.runningCount + rollup.backgroundCount,
  );
  switch (rollup.kind) {
    case "failure":
      return <span>needs attention</span>;
    case "fork":
      return <span>waiting on you: a fork to resolve</span>;
    case "approval":
    case "interview": {
      const what = waiting === null ? null : surfaceWords(waiting);
      return (
        <>
          <span className="min-w-0 truncate text-warning-foreground">
            {what === null ? "waiting on you" : `waiting on you: ${what}`}
          </span>
          {waiting === null ? null : <Age at={waiting.reportedAt} />}
        </>
      );
    }
    case "running":
      return <span>{agentsWorking(working)}</span>;
    case "background":
      return <span>{agentsWorking(working)} in the background</span>;
    case "done":
      return (
        <span className="tabular-nums">
          {entry.task.lastCheckinAt === null
            ? "done"
            : `done ${formatAbsoluteDateTime(entry.task.lastCheckinAt)}`}
        </span>
      );
    case "terminal-failure":
      return <span>a terminal failed</span>;
  }
}

function Age(props: { readonly at: number }): ReactNode {
  return <span className="tabular-nums">{useRelativeTimestamp(props.at)}</span>;
}

/**
 * "agents on {host}, offline" for a task whose agents this window cannot
 * read because the host that last reported it is unreachable. Nothing while
 * no host has reported the task.
 */
function TaskHostOffline(props: { readonly task: BotTaskEntry }): ReactNode {
  const host = reportingHostOf(props.task);
  if (host === null) return null;
  return <HostOfflineWords hostId={host.hostId} hostName={host.hostName} />;
}

function HostOfflineWords(props: {
  readonly hostId: string;
  readonly hostName: string;
}): ReactNode {
  const reachability = useHostReachability(props.hostId);
  if (reachability.status !== "unreachable") return null;
  return (
    <span data-testid="bot-activity-task-offline">
      agents on {props.hostName}, offline
    </span>
  );
}

/** The host a surface of the task, else its newest check-in, came from. */
function reportingHostOf(
  task: BotTaskEntry,
): { readonly hostId: string; readonly hostName: string } | null {
  const waiting = newestWaiting(task.inputNeeded ?? []);
  if (waiting !== null) {
    return { hostId: waiting.hostId, hostName: waiting.hostName };
  }
  const reported = task.checkins?.find((record) => record.kind === "received");
  if (reported?.kind === "received" && reported.hostId !== null) {
    return { hostId: reported.hostId, hostName: reported.hostName };
  }
  return null;
}

/**
 * "from thread <its post's first line>" for a task a thread of the bot
 * started; "from a thread" while that post is not read, and nothing for the
 * trunk's own task.
 */
function FromThread(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly task: BotTaskEntry;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
}): ReactNode {
  const { botId, hostId, task, threads } = props;
  const threadId = task.createdByChatId;
  if (threadId === null) return null;
  const thread =
    threads?.find((listed) => listed.threadId === threadId) ?? null;
  const anchor = thread?.anchor ?? null;
  if (thread === null || anchor === null) {
    return <span data-testid="bot-activity-task-thread">from a thread</span>;
  }
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
        return (
          <span
            className="min-w-0 truncate"
            data-testid="bot-activity-task-thread"
          >
            {line === null ? "from a thread" : `from thread “${line}”`}
          </span>
        );
      }}
    </ChannelPost>
  );
}

function TaskMenu(props: { readonly onOpen: () => void }): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Task actions"
          data-testid="bot-activity-task-menu"
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-testid="bot-activity-task-open-brief"
          onSelect={props.onOpen}
        >
          Open the brief
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The task's agents folded under its row, as the Chats panel lists them in
 * its default view: the tree's order and nesting, archived agents hidden
 * unless one is working or holds something unread or pending.
 */
function TaskAgentRows(props: {
  readonly taskId: string;
  readonly agents: BotTaskAgents;
  readonly agentStates: ReadonlyArray<TaskAgentState>;
  readonly tiers: ReadonlyMap<string, AgentActivityTier>;
  readonly inputNeeded: ReadonlyArray<BotInputNeeded>;
}): ReactNode {
  const { taskId, agents, tiers, inputNeeded } = props;
  const { nodes, archiveHidden, tree } = agents;
  const stateById = useMemo(
    () =>
      new Map(
        props.agentStates.map((agent) => [
          agent.id,
          withSurfaces(agent.indicator, inputNeeded, agent.id),
        ]),
      ),
    [inputNeeded, props.agentStates],
  );
  const hidden = useMemo(() => {
    const notable = nodes
      .filter(
        (node) =>
          chatDescendantKind(
            stateById.get(node.id) ?? EMPTY_NOTIFICATION_INDICATOR_STATE,
            tiers.get(node.id),
          ) !== null,
      )
      .map((node) => node.id);
    return revealArchiveHiddenIds(archiveHidden, notable, tree);
  }, [archiveHidden, nodes, stateById, tiers, tree]);
  const shown = nodes.filter((node) => !hidden.has(node.id));
  return (
    <ul className="flex flex-col pl-7.5" data-testid="bot-activity-task-agents">
      {shown.map((node) => (
        <li key={node.id}>
          <TaskAgentRow
            taskId={taskId}
            node={node}
            sessionHostId={agents.sessionHostId}
            kind={ownChatStatusKind(
              stateById.get(node.id) ?? EMPTY_NOTIFICATION_INDICATOR_STATE,
              tiers.get(node.id),
              "covered",
            )}
          />
        </li>
      ))}
    </ul>
  );
}

const AGENT_STATE_WORDS: Readonly<Record<ChatDescendantStatusKind, string>> = {
  failure: "needs attention",
  fork: "fork to resolve",
  interview: "waiting on you",
  approval: "approval",
  running: "working",
  background: "working in the background",
  done: "finished",
  "terminal-failure": "terminal failed",
};

/** One agent of the task: its own glyph, its state and since when, opening it in the task. */
function TaskAgentRow(props: {
  readonly taskId: string;
  readonly node: BotTaskAgentNode;
  readonly sessionHostId: string | null;
  readonly kind: ChatDescendantStatusKind | "unknown" | null;
}): ReactNode {
  const { taskId, node, sessionHostId } = props;
  const kind = props.kind === "unknown" ? null : props.kind;
  const refs = useMemo(
    () => [{ epicId: taskId, agentId: node.id }],
    [taskId, node.id],
  );
  const [live] = useRegisteredEpicLiveAgents(refs);
  const openRef = useChatRowOpenRef({
    epicId: taskId,
    nodeId: node.id,
    nodeName: node.title,
    openableType: live?.kind ?? "chat",
    ownerHostId: live?.hostId ?? null,
    ownerUserId: live?.userId ?? null,
    sessionHostId,
  });
  const navigate = useNavigate();
  const requestJump = useChatTranscriptJumpStore((state) => state.requestJump);
  return (
    <button
      type="button"
      data-testid="bot-activity-agent"
      data-agent-id={node.id}
      data-kind={kind ?? "idle"}
      onClick={() => {
        const tile = openRef();
        activateTabIntent(
          navigate,
          resourceEpicTabIntent({
            epicId: taskId,
            tabId: null,
            name: undefined,
            focus: NO_FOCUS,
            preparation: { kind: "open-tile", node: tile, gesture: "single" },
            includeNestedFocus: true,
          }),
          undefined,
        );
        if (tile.type === "chat") {
          requestJump(tile.hostId, tile.id, { kind: "end" });
        }
      }}
      style={{ paddingLeft: `${node.depth}rem` }}
      className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1 pr-1 text-left text-ui-xs hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
        {kind === null ? null : <NestedChatStatusGlyph kind={kind} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {displayTitle(node.title, "agent")}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {kind === null ? "idle" : AGENT_STATE_WORDS[kind]} ·{" "}
        <Age at={node.updatedAt} />
      </span>
    </button>
  );
}
