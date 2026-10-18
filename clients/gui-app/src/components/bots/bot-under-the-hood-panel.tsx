import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { Badge } from "@/components/ui/badge";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import { BotTranscriptOffline } from "@/components/bots/bot-transcript-offline";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
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
const EMPTY_STOP_IDS: ReadonlySet<string> = new Set();
const noop = (): void => undefined;
const noStop = (): string | null => null;

/**
 * What the bot is doing (Tracy Bots): the tasks it tracks and when each
 * checks in, the check-ins waiting on its queue, the ones it has already
 * read, the background work its trunk is running, and the trunk transcript
 * itself - the existing chat view, read-only, with no composer: a person
 * talks to the bot in the conversation, never on its trunk.
 */
export function BotUnderTheHoodPanel(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly trunkChatId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** The stream's open-request hint; `null` is unknown and renders nothing. */
  readonly openRequestCount: number | null;
  /** The bound host's label while it is offline and this tab is not on it:
   * the trunk is that host's to serve, so a placeholder stands in for it. The
   * task list comes from the stream snapshot and keeps rendering. */
  readonly offlineHostLabel: string | null;
}): ReactNode {
  const {
    botId,
    hostId,
    botTitle,
    trunkChatId,
    tasks,
    openRequestCount,
    offlineHostLabel,
  } = props;
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:grid-rows-1">
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-border/60 p-4 @3xl:border-r @3xl:border-b-0">
          <BotTasksList tasks={tasks} />
          {offlineHostLabel === null ? (
            <BotTrunkState
              botId={botId}
              hostId={hostId}
              trunkChatId={trunkChatId}
              openRequestCount={openRequestCount}
            />
          ) : null}
        </div>
        <div className="flex min-h-0 flex-col">
          <h3 className="shrink-0 px-4 pt-3 pb-1 text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
            Trunk
          </h3>
          {offlineHostLabel === null ? (
            <BotChatTranscript
              botId={botId}
              chatId={trunkChatId}
              hostId={hostId}
              title={botTitle}
              instanceId={`bot-trunk:${botId}`}
              linkRequests={false}
            />
          ) : (
            <BotTranscriptOffline hostLabel={offlineHostLabel} />
          )}
        </div>
      </div>
    </div>
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
              ? "1 request in the conversation is still open."
              : `${openRequestCount} requests in the conversation are still open.`}
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
