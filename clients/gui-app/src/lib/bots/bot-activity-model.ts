import type {
  BotActivity,
  BotActivityTarget,
  BotCheckinTurn,
  BotSessionActivity,
  BotTaskCheckinRecord,
  BotTaskEntry,
  BotTaskLastCheckin,
} from "@traycer/protocol/host/bot/schemas";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { EpicAgentActivity } from "@/lib/agent-activity";

/**
 * What a bot's Activity page reads (Tracy Bots, decision 115): one page
 * for the bot, across its trunk and every thread. A row is the bot's when
 * the bot, through its trunk or any thread, started the thing or owns it:
 * the tasks on its task list (T82), and the chats that live under the bot
 * itself (its trunk, its threads' sessions and the agents they started).
 * Never another task's agents, nor any other chat the viewer can see.
 */

/** The Activity page's "this week", the window the host keeps check-ins for. */
const ACTIVITY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Check-ins shown under an automation before "All N check-ins". */
export const RECENT_CHECKINS_SHOWN = 5;

/** One of the bot's sessions that failed or parked answering a request. */
export type BotStoppedSession = {
  readonly target: BotActivityTarget;
  readonly session: BotSessionActivity;
  readonly requestId: string;
};

/** The bot's sessions that stopped answering a request, the trunk first. */
export function stoppedSessionsOf(
  activity: BotActivity | null,
): ReadonlyArray<BotStoppedSession> {
  if (activity === null) return [];
  const stopped: BotStoppedSession[] = [];
  const add = (target: BotActivityTarget, session: BotSessionActivity) => {
    if (session.state !== "failed" && session.state !== "parked") return;
    if (session.requestId === null) return;
    stopped.push({ target, session, requestId: session.requestId });
  };
  if (activity.trunk !== null) add({ kind: "trunk" }, activity.trunk);
  for (const [threadId, session] of Object.entries(activity.threads)) {
    add({ kind: "thread", threadId }, session);
  }
  return stopped;
}

/**
 * Where the post a stopped session failed on is: `sentIn` the record it was
 * sent in, whose row holds its text (`null` while the thread list does not
 * have its thread), `threadId` the thread it was sent in (`null` for a post
 * in the channel, a thread's own post included), and `anchor` the channel
 * post whose thread opens it, `startsThread` when no thread hangs off it
 * yet and opening it opens the box that starts one.
 */
export type BotStoppedPost = {
  readonly messageId: string;
  readonly sentIn: string | null;
  readonly threadId: string | null;
  readonly anchor: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly startsThread: boolean;
  } | null;
};

export function stoppedPostOf(
  stopped: BotStoppedSession,
  threads: ReadonlyArray<BotThreadSummary> | null,
  channelId: string | null,
): BotStoppedPost {
  const messageId = conversationRequestMessageId(stopped.requestId);
  const target = stopped.target;
  if (target.kind === "trunk") {
    return {
      messageId,
      sentIn: channelId,
      threadId: null,
      anchor:
        channelId === null
          ? null
          : {
              conversationId: channelId,
              messageId,
              startsThread: !(threads ?? []).some(
                (thread) => thread.anchor?.messageId === messageId,
              ),
            },
    };
  }
  const thread =
    threads?.find((listed) => listed.threadId === target.threadId) ?? null;
  if (thread === null) {
    return { messageId, sentIn: null, threadId: null, anchor: null };
  }
  const anchor = thread.anchor;
  const ownPost = anchor?.messageId === messageId;
  return {
    messageId,
    sentIn: ownPost ? thread.conversationId : thread.threadId,
    threadId: ownPost ? null : thread.threadId,
    anchor:
      anchor === null
        ? null
        : {
            conversationId: thread.conversationId,
            messageId: anchor.messageId,
            startsThread: false,
          },
  };
}

/**
 * What runs for the bot now, one row each: a task with agents working in it,
 * one of the bot's sessions with background work going (a shell, a watch, a
 * subagent) once its turn is over, and an agent the bot started that is
 * working.
 */
export type BotRunningRow =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly agents: number;
    }
  | {
      readonly kind: "session";
      readonly chatId: string;
      readonly target: BotActivityTarget;
    }
  | { readonly kind: "agent"; readonly chatId: string };

export function runningRowsOf(input: {
  /** The bot's tasks, as its task list holds them. */
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** Agents working in each task, by task id. */
  readonly workingInTask: (taskId: string) => number;
  /** The chats living under the bot, as the activity plane reports them. */
  readonly botChats: EpicAgentActivity;
  readonly trunkChatId: string;
  /**
   * The thread each of the bot's thread sessions belongs to, by session chat
   * id; `null` while the thread list is not read, when no chat but the trunk
   * can be told apart and the others wait.
   */
  readonly threadOfSession: ReadonlyMap<string, string> | null;
}): ReadonlyArray<BotRunningRow> {
  const { tasks, workingInTask, botChats, trunkChatId, threadOfSession } =
    input;
  const rows: BotRunningRow[] = [];
  for (const task of tasks) {
    const agents = workingInTask(task.taskId);
    if (agents > 0) rows.push({ kind: "task", taskId: task.taskId, agents });
  }
  for (const chatId of [...botChats.working].sort()) {
    if (chatId !== trunkChatId && threadOfSession === null) continue;
    const threadId = threadOfSession?.get(chatId);
    if (chatId !== trunkChatId && threadId === undefined) {
      rows.push({ kind: "agent", chatId });
      continue;
    }
    // A session answering is the channel's typing line; what is left
    // running once its turn ends is the background work.
    if (botChats.turn.has(chatId)) continue;
    rows.push({
      kind: "session",
      chatId,
      target:
        threadId === undefined
          ? { kind: "trunk" }
          : { kind: "thread", threadId },
    });
  }
  return rows;
}

/** One count of the Activity tab's label. */
export type BotActivityLabelPart = {
  readonly kind: "stopped" | "running" | "tasks";
  readonly text: string;
};

/** The tab's label after "Activity", stopped work first; zero counts are left out. */
export function activityLabelParts(counts: {
  readonly stopped: number;
  readonly running: number;
  readonly tasks: number;
}): ReadonlyArray<BotActivityLabelPart> {
  const parts: BotActivityLabelPart[] = [];
  if (counts.stopped > 0) {
    parts.push({ kind: "stopped", text: `${counts.stopped} stopped` });
  }
  if (counts.running > 0) {
    parts.push({ kind: "running", text: `${counts.running} running` });
  }
  if (counts.tasks > 0) {
    parts.push({ kind: "tasks", text: plural(counts.tasks, "task") });
  }
  return parts;
}

/** The tasks and automations the bot still runs. */
export function trackingTasksOf(
  tasks: ReadonlyArray<BotTaskEntry>,
): ReadonlyArray<BotTaskEntry> {
  return tasks.filter((task) => task.state === "tracking");
}

/**
 * One row of an automation's check-ins: a host's report, a stretch no host
 * reported, or, from a host that keeps no history, the last report alone.
 */
export type BotCheckinRow =
  | {
      readonly kind: "received";
      readonly key: string;
      readonly at: number;
      readonly hostName: string | null;
      readonly said: string;
      /** The turn the bot took on it; `null` where the host recorded none. */
      readonly turn: BotCheckinTurn | null;
      /** The member whose Run now it answered; `null` for a scheduled one. */
      readonly requestedByUserId: string | null;
    }
  | {
      readonly kind: "missed";
      readonly key: string;
      readonly at: number;
      /** When the next report came in; `null` while none has. */
      readonly caughtUpAt: number | null;
    };

/**
 * A task's check-ins, newest first: its history, or its last check-in where
 * the host serves none (a host that predates the history, or one whose
 * history is empty though it knows a last check-in).
 */
export function checkinRowsOf(
  task: BotTaskEntry,
): ReadonlyArray<BotCheckinRow> {
  const history = task.checkins;
  if (history !== null && history.length > 0) {
    return history.map((record, index) => checkinRowOf(record, index));
  }
  const last = task.lastCheckin;
  if (last === null) return [];
  return [
    {
      kind: "received",
      key: `last:${last.deliveredAt}`,
      at: last.deliveredAt,
      hostName: null,
      said: describeLastCheckin(last),
      turn: null,
      requestedByUserId: null,
    },
  ];
}

function checkinRowOf(
  record: BotTaskCheckinRecord,
  index: number,
): BotCheckinRow {
  if (record.kind === "missed") {
    return {
      kind: "missed",
      key: `missed:${record.dueAt}:${index}`,
      at: record.dueAt,
      caughtUpAt: record.caughtUpAt,
    };
  }
  return {
    kind: "received",
    key: `received:${record.receivedAt}:${index}`,
    at: record.receivedAt,
    hostName: record.hostName,
    said: describeReport(record),
    turn: record.turn,
    requestedByUserId: record.requestedByUserId,
  };
}

/** What a report said, in counts. */
function describeReport(
  record: Extract<BotTaskCheckinRecord, { readonly kind: "received" }>,
): string {
  if (record.outcome === "deleted" || record.outcome === "deleted-owner") {
    return "The task was deleted";
  }
  return describeCounts({
    agents: record.agentsStarted,
    opened: record.ticketsOpened,
    closed: record.ticketsClosed,
    events: record.backgroundEvents,
  });
}

function describeLastCheckin(last: BotTaskLastCheckin): string {
  const { agentsStarted, tickets, backgroundEvents } = last.sections;
  return describeCounts({
    agents: agentsStarted.available
      ? agentsStarted.rows.length + agentsStarted.omitted
      : null,
    opened: tickets.rows.filter((row) => row.move === "opened").length,
    closed: tickets.rows.filter((row) => row.move === "closed").length,
    events: backgroundEvents.rows.length + backgroundEvents.omitted,
  });
}

function describeCounts(counts: {
  readonly agents: number | null;
  readonly opened: number;
  readonly closed: number;
  readonly events: number;
}): string {
  const parts: string[] = [];
  if (counts.agents !== null && counts.agents > 0) {
    parts.push(`${plural(counts.agents, "agent")} started`);
  }
  if (counts.opened > 0)
    parts.push(`${plural(counts.opened, "ticket")} opened`);
  if (counts.closed > 0)
    parts.push(`${plural(counts.closed, "ticket")} closed`);
  if (counts.events > 0) {
    parts.push(plural(counts.events, "background event"));
  }
  return parts.length === 0 ? "Nothing new" : parts.join(", ");
}

/**
 * A task the bot no longer runs, with when it ended as far as the stream
 * says: when a member stopped it, else its latest check-in. `null` for one
 * with neither, which only "All finished work" lists.
 */
export type BotFinishedTask = {
  readonly task: BotTaskEntry;
  readonly endedAt: number | null;
};

export function finishedTasksOf(
  tasks: ReadonlyArray<BotTaskEntry>,
): ReadonlyArray<BotFinishedTask> {
  return tasks
    .filter((task) => task.state === "ended")
    .map((task) => ({ task, endedAt: task.stop?.at ?? latestCheckinAt(task) }))
    .sort((a, b) => (b.endedAt ?? -1) - (a.endedAt ?? -1));
}

/** The finished tasks of the week before `now`. */
export function finishedThisWeek(
  finished: ReadonlyArray<BotFinishedTask>,
  now: number,
): ReadonlyArray<BotFinishedTask> {
  return finished.filter(
    (entry) => entry.endedAt !== null && entry.endedAt > now - ACTIVITY_WEEK_MS,
  );
}

function latestCheckinAt(task: BotTaskEntry): number | null {
  const newest = task.checkins?.[0];
  if (newest !== undefined) {
    return newest.kind === "received"
      ? newest.receivedAt
      : (newest.caughtUpAt ?? newest.missedThrough);
  }
  return task.lastCheckin?.deliveredAt ?? task.lastCheckinAt;
}

/** Why a task ended, in words. */
export function endedReasonWords(task: BotTaskEntry): string {
  switch (task.endedReason) {
    case "completed":
      return "Completed";
    case "by-bot":
      return "Stopped";
    case "deleted":
      return "Deleted";
    case "archived":
      return "Archived";
    case null:
      return "Ended";
  }
}

/** The tickets a finished task's last check-in closed, by title. */
export function producedTicketsOf(task: BotTaskEntry): ReadonlyArray<string> {
  const rows = task.lastCheckin?.sections.tickets.rows ?? [];
  return rows
    .filter((row) => row.move === "closed" && row.title.length > 0)
    .map((row) => row.title);
}

function plural(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}
