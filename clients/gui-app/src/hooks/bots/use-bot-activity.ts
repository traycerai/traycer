import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotSubscriptionForHost } from "@/hooks/bots/use-bot-subscription";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useBotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

/**
 * What one of a bot's sessions is doing (Tracy Bots T64):
 *
 * - `replying` while its turn runs;
 * - `parked` when its queue is paused on a delivery;
 * - `failed` when its last turn failed after the latest post it has not
 *   answered;
 * - `idle` otherwise.
 *
 * `step` is what the running turn is doing now, `startedAt` when the turn
 * began, and `requestId` the post being answered, when known.
 */
export type BotSessionActivityState = "idle" | "replying" | "parked" | "failed";

export interface BotSessionActivity {
  readonly state: BotSessionActivityState;
  /** Epoch ms, like every other `bot.*` timestamp. */
  readonly startedAt: number | null;
  readonly step: string | null;
  readonly requestId: string | null;
}

/**
 * The bot's live activity: its trunk (`null` where this client cannot read
 * it) and its threads by thread id. A session absent from it reads idle, as
 * an `idle` entry does.
 */
export interface BotActivity {
  readonly trunk: BotSessionActivity | null;
  readonly threads: Readonly<Record<string, BotSessionActivity>>;
}

/**
 * Every read of what a bot is doing goes through here: the channel's and a
 * thread's typing lines, the closed threads' lines, the Tracy entry and the
 * notice after a turn fails. `null` while this client's host is not the
 * one the bot is bound to.
 *
 * INTERIM until `bot.subscribe` carries `activity` (T64). This body derives
 * the same shape on the client, through the host the bot's tab is bound to:
 * the trunk's and the open thread's own sessions (`chat.subscribe`), the
 * channel for the direct post the trunk is answering, and the agent-activity
 * plane for the threads that are not open (replying only, no step; absent
 * for a team bot on a sandbox, which T64 closes). When the host half lands,
 * the body becomes a read of the `bot.subscribe` handle and nothing that
 * calls it changes.
 */
export function useBotActivity(botId: string): BotActivity | null {
  const { hostId, bot, serving } = useServingBot(botId);
  const tabHostId = hostId ?? "";

  const channel = useChatSessionHandleForContainer(
    botId,
    bot?.appConversationChatId ?? "",
    tabHostId,
    serving && bot?.appConversationChatId !== null,
  );
  const openDirectRequestId = useSessionValue(
    channel,
    readOpenDirectRequestId,
    null,
  );
  const trunk = useSessionTurn(
    useChatSessionHandleForContainer(
      botId,
      bot?.trunkChatId ?? "",
      tabHostId,
      serving && bot !== null,
    ),
  );

  const client = useHostClientForHostId(hostId);
  const threadListSupported =
    useHostMethodSupport(hostId, "bot.thread.list") === true;
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: serving && threadListSupported,
  });
  const threads = threadList.data?.threads;
  const open = useBotOpenThread(botId);
  const openThread = useMemo(
    () =>
      open === null
        ? null
        : (threads?.find(
            (thread) => thread.anchor?.messageId === open.anchorMessageId,
          ) ?? null),
    [open, threads],
  );
  const openTurn = useSessionTurn(
    useChatSessionHandleForContainer(
      botId,
      openThread?.sessionChatId ?? "",
      tabHostId,
      serving && openThread !== null,
    ),
  );
  const { turn: runningSessions } = useEpicAgentActivity(botId);

  return useMemo(
    () =>
      serving
        ? {
            trunk: sessionActivity(trunk, openDirectRequestId),
            threads: threadActivity(
              threads ?? [],
              runningSessions,
              openThread,
              openTurn,
            ),
          }
        : null,
    [
      openDirectRequestId,
      openThread,
      openTurn,
      runningSessions,
      serving,
      threads,
      trunk,
    ],
  );
}

/**
 * The bot as its tab's host serves it: the host the tab is bound to, the
 * bot's record from its stream, and whether that host runs the bot. Only
 * the bound host runs the bot's sessions; a paused tab reads nothing.
 */
function useServingBot(botId: string): {
  readonly hostId: string | null;
  readonly bot: BotRecord | null;
  readonly serving: boolean;
} {
  const hostId = useBotTabsStore(
    (state) => lookupBotTab(state.tabs, botId)?.hostId ?? null,
  );
  const { snapshot } = useBotSubscriptionForHost({
    botId,
    hostId: hostId ?? "",
    enabled: hostId !== null,
  });
  return {
    hostId,
    bot: snapshot?.bot ?? null,
    serving:
      hostId !== null && snapshot !== null && snapshot.boundHost.isThisHost,
  };
}

/**
 * Each thread replying as the agent-activity plane reports its session, and
 * the open thread as its own session reports it.
 */
function threadActivity(
  threads: ReadonlyArray<BotThreadSummary>,
  runningSessions: ReadonlySet<string>,
  openThread: BotThreadSummary | null,
  openTurn: SessionTurn,
): Readonly<Record<string, BotSessionActivity>> {
  const byThread: Record<string, BotSessionActivity> = {};
  for (const thread of threads) {
    if (runningSessions.has(thread.sessionChatId)) {
      byThread[thread.threadId] = PLANE_REPLYING;
    }
  }
  if (openThread !== null) {
    const activity = sessionActivity(openTurn, threadRequestId(openThread));
    if (activity.state === "idle") delete byThread[openThread.threadId];
    else byThread[openThread.threadId] = activity;
  }
  return byThread;
}

const PLANE_REPLYING: BotSessionActivity = {
  state: "replying",
  startedAt: null,
  step: null,
  requestId: null,
};

/** One session's turn and queue, as its own stream reports them. */
interface SessionTurn {
  readonly replying: boolean;
  readonly step: string | null;
  readonly startedAt: number | null;
  readonly queue: "empty" | "pending" | "paused";
  readonly lastTurnFailed: boolean;
}

const IDLE_TURN: SessionTurn = {
  replying: false,
  step: null,
  startedAt: null,
  queue: "empty",
  lastTurnFailed: false,
};

/**
 * `requestId` is the post the session owes an answer to; with none, a
 * failure is not one the person is waiting on.
 */
function sessionActivity(
  turn: SessionTurn,
  requestId: string | null,
): BotSessionActivity {
  if (turn.replying) {
    return {
      state: "replying",
      startedAt: turn.startedAt,
      step: turn.step,
      requestId,
    };
  }
  if (turn.queue === "paused") {
    return { state: "parked", startedAt: null, step: null, requestId };
  }
  if (requestId !== null && turn.queue === "empty" && turn.lastTurnFailed) {
    return { state: "failed", startedAt: null, step: null, requestId };
  }
  return { state: "idle", startedAt: null, step: null, requestId };
}

/** A thread's request while its post is unanswered. */
function threadRequestId(thread: BotThreadSummary): string | null {
  if (thread.openRequestCount === 0) return null;
  const anchor = thread.anchor;
  return anchor !== null && anchor.resolvedAt === null
    ? anchor.requestId
    : null;
}

function useSessionTurn(handle: ChatSessionStoreHandle | null): SessionTurn {
  // One reading per store change, kept while nothing it holds moved, so the
  // external-store snapshot is stable between renders.
  const lastRef = useRef<SessionTurn>(IDLE_TURN);
  const read = useCallback((state: ChatSessionState): SessionTurn => {
    const next = readSessionTurn(state);
    const last = lastRef.current;
    if (
      last.replying === next.replying &&
      last.step === next.step &&
      last.startedAt === next.startedAt &&
      last.queue === next.queue &&
      last.lastTurnFailed === next.lastTurnFailed
    ) {
      return last;
    }
    lastRef.current = next;
    return next;
  }, []);
  return useSessionValue(handle, read, IDLE_TURN);
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/** One stable value of a session's state, or `fallback` with no session. */
function useSessionValue<T>(
  handle: ChatSessionStoreHandle | null,
  read: (state: ChatSessionState) => T,
  fallback: T,
): T {
  const subscribe = useCallback(
    (listener: () => void) =>
      handle === null ? NO_SUBSCRIBE() : handle.store.subscribe(listener),
    [handle],
  );
  return useSyncExternalStore(subscribe, () =>
    handle === null ? fallback : read(handle.store.getState()),
  );
}

function readSessionTurn(state: ChatSessionState): SessionTurn {
  // The host's own `turnInProgress`; an active turn from a host that
  // predates the field.
  const replying = state.turnInProgress ?? state.activeTurn !== null;
  let queue: SessionTurn["queue"] = "empty";
  if (state.queue.status === "paused") queue = "paused";
  else if (state.queue.items.length > 0) queue = "pending";
  return {
    replying,
    step: replying ? readStep(state) : null,
    startedAt: replying ? (state.activeTurn?.startedAt ?? null) : null,
    queue,
    lastTurnFailed: state.lastFailedAttempt !== undefined,
  };
}

/**
 * The channel's latest direct post (reply mode `direct`) its bot has not
 * answered: the post the trunk owes a reply to.
 */
function readOpenDirectRequestId(state: ChatSessionState): string | null {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.role !== "user") continue;
    const request = message.conversationRequest;
    if (request?.direct === true && request.resolvedAt === null) {
      return request.requestId;
    }
  }
  return null;
}

/**
 * The latest call or command the running turn has in flight, as one line.
 * The turn streams into its live row until the row is in the transcript,
 * and into that row after.
 */
function readStep(state: ChatSessionState): string | null {
  const turnId = state.activeTurn?.turnId ?? null;
  const row =
    turnId === null
      ? undefined
      : state.messages.findLast(
          (message) =>
            message.role === "assistant" && message.turnId === turnId,
        );
  const blocks =
    state.liveAssistantMessage?.blocks ??
    (row?.role === "assistant" ? row.blocks : []);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.status !== "streaming") continue;
    if (block.type === "tool_call") {
      return firstLine(block.progress ?? block.inputSummary);
    }
    if (block.type === "command") return firstLine(block.command);
  }
  return null;
}

/** The longest step a session reports, as T64's labeler caps it. */
const ACTIVITY_LABEL_MAX_LENGTH = 96;

function firstLine(text: string | null): string | null {
  const line = text?.split("\n", 1)[0].trim() ?? "";
  if (line.length === 0) return null;
  return line.length > ACTIVITY_LABEL_MAX_LENGTH
    ? `${line.slice(0, ACTIVITY_LABEL_MAX_LENGTH - 1)}…`
    : line;
}
