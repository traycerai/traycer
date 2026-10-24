/**
 * Shared fixtures for the `traycer bot` command tests: bot / task /
 * conversation records, a fake stream client whose sessions the test drives,
 * and builders for the server frames the commands read.
 *
 * The frames are plain objects shaped like the wire; the commands parse them
 * with the real protocol schemas, so a fixture the schemas reject fails the
 * command under test rather than passing silently.
 */

import { vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotConversationRecord } from "@traycer/protocol/host/bot/conversation-schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer/protocol/host-transport/stream-session";
import { unsupportedHostMethodError } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";
import type { StreamMethodSupport } from "../../../../shared/host-transport/ws-stream-client";
import type { BotStreamClient } from "../../internal/bot-host";
import { noopLogger } from "../../logger";
import type { CommandContext } from "../../runner/runner";

// ---- ids and records ---------------------------------------------------- //

/** Valid bot ids: `bot_` + a Crockford ULID whose first digit is `[0-7]`. */
export const BOT_ID_A = "bot_01HZZZZZZZZZZZZZZZZZZZZZZZ";
export const BOT_ID_B = "bot_01HYYYYYYYYYYYYYYYYYYYYYYY";
export const BOT_ID_C = "bot_01HXXXXXXXXXXXXXXXXXXXXXXX";

export const THIS_HOST_ID = "host-here";
export const OTHER_HOST_ID = "host-elsewhere";

export function botRecord(overrides: Partial<BotRecord>): BotRecord {
  return {
    botId: BOT_ID_A,
    environmentId: "env-personal",
    createdByUserId: "user-1",
    title: "Tracy",
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: "trunk-1",
    boundHostId: THIS_HOST_ID,
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    appConversationChatId: null,
    ...overrides,
  };
}

export function environmentDescriptor(
  environmentId: string,
  label: string,
): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
  };
}

export function taskEntry(overrides: Partial<BotTaskEntry>): BotTaskEntry {
  return {
    taskId: "task-1",
    cadence: { kind: "every", seconds: 3600 },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    ...overrides,
  };
}

export function conversationRecord(
  overrides: Partial<BotConversationRecord>,
): BotConversationRecord {
  return {
    conversationId: "conv-1",
    botId: BOT_ID_A,
    title: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

// ---- fake stream client ------------------------------------------------- //

/** One open subscription the test drives by hand. */
export class FakeStreamSession implements IStreamSession {
  readonly method: string;
  readonly params: unknown;
  /** Every client frame the command sent, in order. */
  readonly sent: StreamFrameEnvelope[] = [];
  closeCount = 0;
  private frameHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;

  constructor(method: string, params: unknown) {
    this.method = method;
    this.params = params;
  }

  sendClientFrame(envelope: StreamFrameEnvelope): void {
    this.sent.push(envelope);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.frameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
  }

  requestReconnect(): void {
    // The fake never owns a socket, so there is nothing to re-dial.
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {
    this.closeCount += 1;
  }

  /** Delivers a server frame to the handler the command installed. */
  pushFrame(frame: StreamFrameEnvelope): void {
    if (this.frameHandler === null) {
      throw new Error("the command installed no onServerFrame handler");
    }
    this.frameHandler(frame, null);
  }

  /** Fires the status handler the command installed. */
  pushStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    if (this.statusHandler === null) {
      throw new Error("the command installed no onStatusChange handler");
    }
    this.statusHandler(status, reason, null);
  }
}

/**
 * The stream client the bot commands use. `script` runs in a microtask after
 * each `subscribe`, once the command has installed its handlers, so a test can
 * answer a `bot.subscribe` the way a host would. `waitForBotReply` tests pass
 * a script that does nothing and drive `sessions[0]` themselves.
 */
export class FakeStreamClient implements BotStreamClient {
  readonly sessions: FakeStreamSession[] = [];
  /** The reason string of every `close` call. */
  readonly closeReasons: string[] = [];
  methodSupport: StreamMethodSupport = "supported";
  private readonly script: (session: FakeStreamSession) => void;

  constructor(script: (session: FakeStreamSession) => void) {
    this.script = script;
  }

  subscribe(method: string, params: unknown): FakeStreamSession {
    const session = new FakeStreamSession(method, params);
    this.sessions.push(session);
    queueMicrotask(() => {
      this.script(session);
    });
    return session;
  }

  getMethodSupport(): StreamMethodSupport {
    return this.methodSupport;
  }

  close(reason: string): void {
    this.closeReasons.push(reason);
  }
}

/** The client a `bot.subscribe`-only command gets: it answers per bot id. */
export function botSubscribeClient(
  answers: Readonly<Record<string, StreamFrameEnvelope>>,
): FakeStreamClient {
  return new FakeStreamClient((session) => {
    const botId = readStringField(session.params, "botId");
    const answer = botId === null ? undefined : answers[botId];
    if (answer === undefined) {
      throw new Error(`no scripted bot.subscribe answer for ${String(botId)}`);
    }
    session.pushFrame(answer);
  });
}

function readStringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = Object.entries(value).find(([name]) => name === key);
  return field !== undefined && typeof field[1] === "string" ? field[1] : null;
}

// ---- `bot.subscribe` frames --------------------------------------------- //

export function botSnapshotFrame(
  bot: BotRecord,
  tasks: readonly BotTaskEntry[],
  openRequestCount: number | null,
): StreamFrameEnvelope {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    bot,
    tasks,
    openRequestCount,
    conversationsRevision: null,
    boundHost: {
      hostId: bot.boundHostId,
      epoch: bot.hostEpoch,
      isThisHost: false,
    },
  };
}

export function botDeletedFrame(): StreamFrameEnvelope {
  return { kind: "deleted", hasBinaryPayload: false };
}

// ---- `chat.subscribe` frames -------------------------------------------- //

export const CONVERSATION_ID = "conv-1";
export const REQUEST_ID = "req-1";
export const THREAD_ID = "thread-1";
export const REPLY_MESSAGE_ID = "msg-reply";

type Row = Record<string, unknown>;

/** The user row a `bot.conversation.send` writes, carrying its request. */
export function userRow(input: {
  readonly messageId: string;
  readonly requestId: string;
  readonly resolvedAt: number | null;
  readonly resolvedByMessageId: string | null;
}): Row {
  return {
    role: "user",
    messageId: input.messageId,
    sender: { type: "user", userId: "user-1" },
    message: { kind: "user", content: { type: "doc", content: [] } },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: input.requestId,
      resolvedAt: input.resolvedAt,
      resolvedByMessageId: input.resolvedByMessageId,
    },
  };
}

/** A bot reply row whose text blocks are `texts`, in order. */
export function assistantRow(input: {
  readonly messageId: string;
  readonly texts: readonly string[];
}): Row {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-bot",
      displayName: null,
    },
    blocks: input.texts.map((text, index) => ({
      type: "text",
      blockId: `${input.messageId}-block-${index}`,
      status: "completed",
      timestamp: 2_000,
      text,
    })),
    timestamp: 2_000,
    turnId: null,
    usage: null,
  };
}

/** A skeleton entry; only the role and id matter to the commands. */
export function skeletonEntry(rowId: string, role: "user" | "assistant"): Row {
  return {
    rowId,
    createdAt: 1_000,
    role,
    byteLength: 10,
    bodyDigest: `digest-${rowId}`,
  };
}

export function chatSnapshotFrame(input: {
  readonly botId: string;
  readonly conversationId: string;
  readonly epoch: number;
  readonly rowCount: number;
  /** Null announces a fresh index whose skeleton streams next. */
  readonly indexRevision: number | null;
  readonly tailFromOrdinal: number;
  readonly messages: readonly Row[];
}): StreamFrameEnvelope {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: input.botId,
    chatId: input.conversationId,
    snapshot: {
      chat: {
        parentId: null,
        id: input.conversationId,
        userId: "user-1",
        hostId: THIS_HOST_ID,
        title: "Conversation",
        createdAt: 1_000,
        updatedAt: 1_000,
        isTitleEditedByUser: false,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: input.epoch,
      rowCount: input.rowCount,
      indexRevision: input.indexRevision,
      tail: {
        fromOrdinal: input.tailFromOrdinal,
        messages: input.messages,
        events: [],
      },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

/** One chunk of the skeleton a null-revision snapshot announces. */
export function skeletonChunkFrame(input: {
  readonly botId: string;
  readonly conversationId: string;
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly entries: readonly Row[];
  readonly isFinal: boolean;
}): StreamFrameEnvelope {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: input.botId,
    chatId: input.conversationId,
    chunk: {
      epoch: input.epoch,
      fromOrdinal: input.fromOrdinal,
      entries: input.entries,
      isFinal: input.isFinal,
    },
  };
}

export type IndexChange =
  | { readonly type: "appended"; readonly entries: readonly Row[] }
  | {
      readonly type: "updated";
      readonly entries: readonly {
        readonly ordinal: number;
        readonly entry: Row;
      }[];
    }
  | { readonly type: "reindexed" };

export function indexChangedFrame(input: {
  readonly botId: string;
  readonly conversationId: string;
  readonly epoch: number;
  readonly rowCount: number;
  readonly indexRevision: number;
  readonly changes: readonly IndexChange[];
}): StreamFrameEnvelope {
  return {
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: input.botId,
    chatId: input.conversationId,
    epoch: input.epoch,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    changes: input.changes,
  };
}

export function rangeFrame(input: {
  readonly botId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly rowIds: readonly string[];
  /** Rows the host served without their whole body; null when it names none. */
  readonly incompleteRowIds: readonly string[] | null;
  readonly messages: readonly Row[];
  readonly truncatedAtOrdinal: number | null;
}): StreamFrameEnvelope {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: input.botId,
    chatId: input.conversationId,
    range: {
      requestId: input.requestId,
      epoch: input.epoch,
      fromOrdinal: input.fromOrdinal,
      rowIds: input.rowIds,
      ...(input.incompleteRowIds === null
        ? {}
        : { incompleteRowIds: input.incompleteRowIds }),
      messages: input.messages,
      events: [],
      rowContext: {},
      reachedStart: false,
      reachedEnd: input.truncatedAtOrdinal === null,
      ...(input.truncatedAtOrdinal === null
        ? {}
        : { truncatedAtOrdinal: input.truncatedAtOrdinal }),
    },
  };
}

// ---- errors ------------------------------------------------------------- //

/** What the transport throws for a method the connected host lacks. */
export function unsupportedRpcError(method: string): Error {
  return unsupportedHostMethodError(method, "req-1");
}

/** A fatal close; `incompatibleMethod` names the method an INCOMPATIBLE is about. */
export function fatalClose(input: {
  readonly code: string;
  readonly reason: string;
  readonly incompatibleMethod: string | null;
}): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code: input.code,
      reason: input.reason,
      incompatibleMethods:
        input.incompatibleMethod === null
          ? null
          : [
              {
                method: input.incompatibleMethod,
                clientCanonical: { major: 1, minor: 0 },
                hostCanonical: null,
                blocking: "host-missing-method",
              },
            ],
      upgradeGuidance: null,
    },
  };
}

// ---- commands ----------------------------------------------------------- //

/** A runner context; the bot commands read nothing from it. */
export function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

/**
 * Routes a mocked `callHostRpc(method, params)` by method name; a method with
 * no route rejects, so a command that calls an RPC the test did not expect
 * fails loudly.
 */
export function routeRpc(
  routes: Readonly<Record<string, (params: unknown) => unknown>>,
): (method: string, params: unknown) => Promise<unknown> {
  return (method, params) => {
    const route = routes[method];
    if (route === undefined) {
      return Promise.reject(new Error(`unexpected host RPC ${method}`));
    }
    try {
      return Promise.resolve(route(params));
    } catch (error) {
      return Promise.reject(error);
    }
  };
}
