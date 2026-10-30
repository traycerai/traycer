import { QueryClient } from "@tanstack/react-query";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BotThreadSummary,
  BotTurnLocateRequest,
  BotTurnLocateResponse,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import type {
  BotOpenThread,
  BotSessionTarget,
} from "@/stores/bots/bot-open-thread-store";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * The scene the bot turn suites share (Tracy Bots T86): the bot's channel and
 * one thread under it, each with the rows its chat holds, the two sessions
 * that answer them (the trunk's and the thread's) and a host that answers
 * `bot.turn.locate`. The suites own their `vi.mock` calls; this module holds
 * the fixtures they all stand on.
 */

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** The host serving the tab. */
export const HOST_ID = "host-tab";
/** The bot's environment, whose room keeps its memory (T87). */
export const ENVIRONMENT_ID = "env-1";
/** Another bot of the environment, a shared memory's writer. */
export const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const OTHER_BOT_TITLE = "Audit Bot";
/** The bot's channel chat, where members post. */
export const CHANNEL_ID = "conversation-channel";
/** The bot's trunk session, which answers the channel's posts. */
export const TRUNK_ID = "trunk-chat";
/** A thread's own chat, where its replies are written. */
export const THREAD_ID = "thread-1";
/** The session that answers the thread. */
export const THREAD_SESSION_ID = "session-1";
export const POST_ID = "post-1";
export const POST_REQUEST = "req-post";
export const POST_FIRST_LINE = "Is CI green?";
export const POST_SECOND_LINE = "The nightly looks red to me.";
export const REPLY_ID = "reply-1";
export const THREAD_REPLY_ID = "thread-reply-1";

const BOT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

export function textDoc(lines: ReadonlyArray<string>): JsonContent {
  return {
    type: "doc",
    content: lines.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

/** A member's post whose request the bot has answered with `resolvedBy`, or has not (`null`). */
export function memberPost(input: {
  readonly messageId: string;
  readonly requestId: string;
  readonly lines: ReadonlyArray<string>;
  readonly timestamp: number;
  readonly resolvedBy: string | null;
}): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: input.messageId,
    sender: { type: "user", userId: "user-viewer" },
    message: {
      kind: "user",
      content: textDoc(input.lines),
      browserAnnotations: [],
    },
    timestamp: input.timestamp,
    sessionAnchor: null,
    conversationRequest: {
      requestId: input.requestId,
      resolvedAt: input.resolvedBy === null ? null : input.timestamp + 1,
      resolvedByMessageId: input.resolvedBy,
    },
  };
}

function textBlock(blockId: string, text: string, at: number): ContentBlock {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp: at,
    text,
    providerNotice: null,
  };
}

/** One of the bot's replies in a conversation chat (a channel or a thread). */
export function botReply(input: {
  readonly messageId: string;
  readonly text: string;
  readonly timestamp: number;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: BOT_SENDER,
    blocks: [textBlock(`${input.messageId}:text`, input.text, input.timestamp)],
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

/** The message that started a turn in a session chat. */
export function sessionPrompt(
  messageId: string,
  timestamp: number,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "user-viewer" },
    message: {
      kind: "user",
      content: textDoc(["A prompt the host wrote for the bot"]),
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
  };
}

interface ToolCallInput {
  readonly blockId: string;
  readonly toolName: string;
  readonly inputSummary: string;
  readonly agentMessageSend: Extract<
    ContentBlock,
    { type: "tool_call" }
  >["agentMessageSend"];
  readonly startedAt: number;
  readonly endedAt: number;
}

function toolCallBlock(input: ToolCallInput): ContentBlock {
  return {
    type: "tool_call",
    blockId: input.blockId,
    toolName: input.toolName,
    inputSummary: input.inputSummary,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: input.agentMessageSend,
    managedCommand: null,
    agentMessageReceipt: null,
    agentMessageDelivery: null,
    artifact: null,
    mcpApp: null,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    status: "completed",
    timestamp: input.endedAt,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    imageResults: [],
  };
}

function assistantTurn(input: {
  readonly messageId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly costUsd: number;
  readonly blocks: ReadonlyArray<ContentBlock>;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: BOT_SENDER,
    blocks: [...input.blocks],
    startedAt: input.startedAt,
    timestamp: input.endedAt,
    turnId: input.turnId,
    usage: {
      inputTokens: 1_200,
      outputTokens: 300,
      totalTokens: 1_500,
      costUsd: input.costUsd,
    },
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

/**
 * A turn of a session chat that read one file, and what it cost: the record
 * the turn's rail draws its activity group, model and cost from.
 */
export function sessionTurn(input: {
  readonly messageId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly costUsd: number;
}): Extract<Message, { role: "assistant" }> {
  return assistantTurn({
    ...input,
    blocks: [
      toolCallBlock({
        blockId: `${input.messageId}:read`,
        toolName: "Read",
        inputSummary: "src/app.ts",
        agentMessageSend: null,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      }),
      textBlock(`${input.messageId}:text`, "Done.", input.endedAt),
    ],
  });
}

export const SUBAGENT_NAME = "Log reader";
export const SENT_MESSAGE = "Please rerun the nightly.";
export const BACKGROUND_COMMAND = "bun run nightly --watch";
/** The host a browser session of the promoted turn runs on. */
export const BROWSER_HOST_ID = "host-browser";
export const ANSWER_PROSE = "The nightly is red; I asked for a rerun.";

/**
 * A turn that spawned a subagent, started a command that went to the
 * background, sent a message to another agent, opened a browser, and then wrote its answer: the
 * items the agent chat lifts out of its activity groups, and the prose.
 */
export function promotedSessionTurn(input: {
  readonly messageId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly costUsd: number;
}): Extract<Message, { role: "assistant" }> {
  return assistantTurn({
    ...input,
    blocks: [
      {
        type: "subagent",
        blockId: `${input.messageId}:subagent`,
        status: "completed",
        timestamp: input.endedAt,
        name: SUBAGENT_NAME,
        agentType: null,
        task: "Check the nightly logs",
        progressUpdates: [],
        result: "The nightly failed on lint.",
        startedAt: input.startedAt,
        spawnToolCallId: null,
        stopped: false,
        workflowMeta: null,
      },
      {
        type: "command",
        blockId: `${input.messageId}:command`,
        status: "completed",
        timestamp: input.endedAt,
        command: BACKGROUND_COMMAND,
        cwd: null,
        exitCode: 0,
        backgroundTask: true,
        stopped: false,
      },
      toolCallBlock({
        blockId: `${input.messageId}:send`,
        toolName: "mcp__traycer_a2a__traycer_send_message",
        inputSummary: SENT_MESSAGE,
        agentMessageSend: {
          receiverAgentId: "agent-receiver-1234",
          message: SENT_MESSAGE,
          responseId: "response-1",
          expectReply: false,
        },
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      }),
      {
        type: "text",
        blockId: `${input.messageId}:browser`,
        status: "completed",
        timestamp: input.endedAt,
        text: "Opened a browser.",
        providerNotice: null,
        browserSession: {
          hostId: BROWSER_HOST_ID,
          sessionId: "browser-1",
          tabId: "tab-1",
          profile: "primary",
        },
      },
      textBlock(`${input.messageId}:text`, ANSWER_PROSE, input.endedAt),
    ],
  });
}

/** A turn of a bot's session as the host's `bot.turn.locate` names it. */
export function turnRef(input: {
  readonly chatId: string;
  readonly turnId: string;
  readonly userMessageId: string;
  readonly threadId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly summary: string | null;
  readonly messageIds: ReadonlyArray<string>;
  readonly requestIds: ReadonlyArray<string>;
}): BotTurnRef {
  return {
    chatId: input.chatId,
    turnIds: [input.turnId],
    userMessageId: input.userMessageId,
    threadId: input.threadId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    summary: input.summary,
    messageIds: [...input.messageIds],
    requestIds: [...input.requestIds],
  };
}

/** A chat session's store: the real one, which tests drive with `setState`. */
export type SessionStore = ChatSessionStoreHandle["store"];

/**
 * A real chat session store for `chatId`, holding `messages` as a loaded
 * snapshot: an owner on an open stream, with nothing failed or pending. Its
 * stream client does nothing, so only what a case sets reaches the state.
 */
export function scriptedSession(
  chatId: string,
  messages: ReadonlyArray<Message>,
): {
  readonly handle: ChatSessionStoreHandle;
  readonly store: SessionStore;
} {
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: BOT_ID,
    chatId,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
  handle.store.setState({
    snapshotLoaded: true,
    messages: [...messages],
    access: { role: "owner", ownerUserId: "user-viewer", canAct: true },
    connectionStatus: "open",
  });
  return { handle, store: handle.store };
}

/**
 * The tab host's client, over a messenger whose `bot.turn.locate` answers
 * `locate` and records what it was asked.
 */
export function hostClientLocating(
  locate: (request: BotTurnLocateRequest) => BotTurnLocateResponse,
  asked: BotTurnLocateRequest[],
): HostRequester<HostRpcRegistry> {
  const queryClient = new QueryClient();
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.turn.locate": (params) => {
        asked.push(params);
        return Promise.resolve(locate(params));
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** The turns of `turns` that any of the asked ids, requests or keys leads to. */
export function turnsAskedFor(
  turns: ReadonlyArray<BotTurnRef>,
  request: BotTurnLocateRequest,
): BotTurnLocateResponse {
  return {
    turns: turns.filter(
      (turn) =>
        request.messageIds.some((id) => turn.messageIds.includes(id)) ||
        request.requestIds.some((id) => turn.requestIds.includes(id)) ||
        request.turns.some(
          (key) =>
            key.chatId === turn.chatId && turn.turnIds.includes(key.turnId),
        ),
    ),
  };
}

export const SUMMARY = "Read 1 file";
export const REPLY_TURN_ID = "turn-reply";
export const REPLY_PROMPT_ID = "prompt-reply";
export const THREAD_TURN_ID = "turn-thread";
export const THREAD_PROMPT_ID = "prompt-thread";
export const COST_USD = 0.0123;
/** The turns took 1m 20s. */
export const STARTED_AT = 100_000;
export const ENDED_AT = 180_000;
export const TOOK = "1m 20s";

/** The turn of the trunk that wrote `REPLY_ID`. */
export const CHANNEL_REPLY_TURN: BotTurnRef = turnRef({
  chatId: TRUNK_ID,
  turnId: REPLY_TURN_ID,
  userMessageId: REPLY_PROMPT_ID,
  threadId: null,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  summary: SUMMARY,
  messageIds: [REPLY_ID],
  requestIds: [],
});

/** The turn of the thread's session that wrote `THREAD_REPLY_ID`. */
export const THREAD_REPLY_TURN: BotTurnRef = turnRef({
  chatId: THREAD_SESSION_ID,
  turnId: THREAD_TURN_ID,
  userMessageId: THREAD_PROMPT_ID,
  threadId: THREAD_ID,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  summary: SUMMARY,
  messageIds: [THREAD_REPLY_ID],
  requestIds: [],
});

/**
 * The sessions the channel harness asked the tab to open in the channel's
 * place, oldest first: a receipt's turn, or a thread's session from its
 * panel. A suite empties it before each case.
 */
export const openedSessions: BotSessionTarget[] = [];

/** The rail's thread: the one the member's post opened. */
export const THREAD_OPEN: BotOpenThread = {
  anchorMessageId: POST_ID,
  announcement: false,
  anchorKind: null,
  sent: null,
};

/** The thread the member's post opened, one reply in. */
export function postThread(): BotThreadSummary {
  return {
    threadId: THREAD_ID,
    conversationId: CHANNEL_ID,
    sessionChatId: THREAD_SESSION_ID,
    anchor: {
      messageId: POST_ID,
      requestId: POST_REQUEST,
      senderUserId: "user-viewer",
      sentAt: 1_000,
      resolvedAt: 1_001,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

/** The sessions a case reads, by chat id, and the stores behind them. */
export interface Scene {
  readonly sessions: Record<string, ChatSessionStoreHandle>;
  readonly channel: SessionStore;
  readonly trunk: SessionStore;
  readonly threadSession: SessionStore;
  readonly threads: BotThreadSummary[];
  /** What the host knows of the bot's turns; its locate read answers from it. */
  knownTurns: BotTurnRef[];
}

/**
 * The scene: the channel with the member's post (answered) and the bot's
 * reply; the thread the post opened with its reply; and the two sessions
 * that ran those replies' turns.
 */
export function buildScene(): Scene {
  const channel = scriptedSession(CHANNEL_ID, [
    memberPost({
      messageId: POST_ID,
      requestId: POST_REQUEST,
      lines: [POST_FIRST_LINE, POST_SECOND_LINE],
      timestamp: 1_000,
      resolvedBy: REPLY_ID,
    }),
    botReply({ messageId: REPLY_ID, text: "CI is green.", timestamp: 2_000 }),
  ]);
  const thread = scriptedSession(THREAD_ID, [
    botReply({
      messageId: THREAD_REPLY_ID,
      text: "Yes, the thread agrees.",
      timestamp: 3_000,
    }),
  ]);
  const trunk = scriptedSession(TRUNK_ID, [
    sessionPrompt(REPLY_PROMPT_ID, 90_000),
    sessionTurn({
      messageId: "turn-reply-record",
      turnId: REPLY_TURN_ID,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      costUsd: COST_USD,
    }),
  ]);
  const threadSession = scriptedSession(THREAD_SESSION_ID, [
    sessionPrompt(THREAD_PROMPT_ID, 90_000),
    sessionTurn({
      messageId: "turn-thread-record",
      turnId: THREAD_TURN_ID,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      costUsd: COST_USD,
    }),
  ]);
  return {
    sessions: {
      [CHANNEL_ID]: channel.handle,
      [THREAD_ID]: thread.handle,
      [TRUNK_ID]: trunk.handle,
      [THREAD_SESSION_ID]: threadSession.handle,
    },
    channel: channel.store,
    trunk: trunk.store,
    threadSession: threadSession.store,
    threads: [postThread()],
    knownTurns: [CHANNEL_REPLY_TURN, THREAD_REPLY_TURN],
  };
}
