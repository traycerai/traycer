import type { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamClient } from "../i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";
import type { ChatStreamCallbacks } from "../chat-stream-client";

/**
 * A `ChatStreamClient` over a stub session negotiated at a chosen version,
 * and the frames a windowed host sends it. Shared by the tests of what the
 * client hands each callback per negotiated minor.
 */

export class StubStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;

  constructor(private readonly version: SchemaVersion | null) {}

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(): void {}

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.version;
  }

  close(): void {}

  deliver(envelope: StreamFrameEnvelope): void {
    this.serverFrameHandler?.(envelope, null);
  }
}

export function stubClientAtVersion(version: SchemaVersion): {
  readonly wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry>;
  readonly session: StubStreamSession;
} {
  const session = new StubStreamSession(version);
  const wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry> = {
    subscribe: () => session,
    subscribeWithParamsProvider: () => session,
    getMethodSchemaVersion: () => version,
  };
  return { wsStreamClient, session };
}

export function noopCallbacks(
  overrides: Partial<ChatStreamCallbacks>,
): ChatStreamCallbacks {
  return {
    onSnapshot: () => undefined,
    onWindowedSnapshot: () => undefined,
    onSkeletonChunk: () => undefined,
    onIndexChanged: () => undefined,
    onRange: () => undefined,
    onAccumulatedChanges: () => undefined,
    onActionAck: () => undefined,
    onMessageAccepted: () => undefined,
    onMessageDeliveryChanged: () => undefined,
    onQueueChanged: () => undefined,
    onTurnStateChanged: () => undefined,
    onBlockDelta: () => undefined,
    onApprovalRequested: () => undefined,
    onApprovalResolved: () => undefined,
    onFileEditApprovalRequested: () => undefined,
    onFileEditApprovalResolved: () => undefined,
    onInterviewRequested: () => undefined,
    onInterviewAnswered: () => undefined,
    onInterviewErrored: () => undefined,
    onEventAppended: () => undefined,
    onRestoreStarted: () => undefined,
    onRestoreProgress: () => undefined,
    onRestoreCompleted: () => undefined,
    onErrorNotice: () => undefined,
    onWorktreeStateChanged: () => undefined,
    onManagedCommandsChanged: () => undefined,
    onHeldUpdatesChanged: () => undefined,
    onPortForwardsChanged: () => undefined,
    onThinkingTokens: () => undefined,
    onConnectionStatus: () => undefined,
    readSkeletonResume: () => null,
    ...overrides,
  };
}

export const IDS = { epicId: "epic-1", chatId: "chat-1" };

export function eventAppendedEnvelope(
  event: Record<string, unknown>,
): StreamFrameEnvelope {
  return { kind: "eventAppended", hasBinaryPayload: false, ...IDS, event };
}

export function rangeEnvelope(
  events: readonly Record<string, unknown>[],
  messages: readonly Record<string, unknown>[],
): StreamFrameEnvelope {
  return {
    kind: "range",
    hasBinaryPayload: false,
    ...IDS,
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: [],
      messages,
      events,
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

export function snapshotEnvelope(
  events: readonly Record<string, unknown>[],
  messages: readonly Record<string, unknown>[],
): StreamFrameEnvelope {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    ...IDS,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
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
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages, events },
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
