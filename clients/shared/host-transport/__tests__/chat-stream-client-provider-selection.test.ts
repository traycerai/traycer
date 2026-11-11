import { describe, expect, it } from "vitest";
import type { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamClient } from "../i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "../chat-stream-client";

/**
 * `ChatEvent.providerSelection` rides `chat.subscribe@1.44`. The shared stream
 * client decodes a windowed session with the live open union, so a consumer on
 * a 1.44 session must be handed the provenance through each callback a chat
 * event reaches it by - the snapshot's tail, a `range` response and the live
 * `eventAppended` frame - and an event without it must still be delivered.
 * What an OLDER peer's stream carries is the host's concern, pinned by the
 * protocol freeze test and the host emission test, not by this client.
 */

const PROVENANCE_MINOR = 44;

const PROVIDER_SELECTION = {
  homeAddress: "home-1",
  bindingVersion: 3,
  holderRevision: "self",
  dispatchedAt: 1700,
};

class StubStreamSession implements IStreamSession {
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

function stubClientAtVersion(version: SchemaVersion): {
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

function noopCallbacks(
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

function chatEvent(
  eventId: string,
  withSelection: boolean,
): Record<string, unknown> {
  return {
    eventId,
    type: "turn.started",
    timestamp: 1001,
    clientActionId: null,
    // A harness no closed enum names: the live consumer reads actors open.
    actor: {
      type: "agent",
      harnessId: "acme-future-harness",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    message: null,
    turnId: "turn-1",
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
    ...(withSelection ? { providerSelection: PROVIDER_SELECTION } : {}),
  };
}

const IDS = { epicId: "epic-1", chatId: "chat-1" };

function eventAppendedEnvelope(
  event: Record<string, unknown>,
): StreamFrameEnvelope {
  return { kind: "eventAppended", hasBinaryPayload: false, ...IDS, event };
}

function rangeEnvelope(
  events: readonly Record<string, unknown>[],
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
      messages: [],
      events,
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

function snapshotEnvelope(
  events: readonly Record<string, unknown>[],
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
      tail: { fromOrdinal: 0, messages: [], events },
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

describe("ChatStreamClient delivers providerSelection on a negotiated 1.44 session", () => {
  function openClient() {
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: PROVENANCE_MINOR,
    });
    const heard = {
      snapshot: [] as unknown[],
      range: [] as unknown[],
      appended: [] as unknown[],
    };
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: noopCallbacks({
        onWindowedSnapshot: (frame) => {
          heard.snapshot.push(...frame.snapshot.tail.events);
        },
        onRange: (frame) => {
          heard.range.push(...frame.range.events);
        },
        onEventAppended: (frame) => {
          heard.appended.push(frame.event);
        },
      }),
    });
    return { client, session, heard };
  }

  it("hands the snapshot tail, a range response and eventAppended the provenance", () => {
    const { client, session, heard } = openClient();

    session.deliver(snapshotEnvelope([chatEvent("event-tail", true)]));
    session.deliver(rangeEnvelope([chatEvent("event-range", true)]));
    session.deliver(eventAppendedEnvelope(chatEvent("event-live", true)));

    expect(heard.snapshot).toHaveLength(1);
    expect(heard.snapshot[0]).toMatchObject({
      eventId: "event-tail",
      providerSelection: PROVIDER_SELECTION,
    });
    expect(heard.range).toHaveLength(1);
    expect(heard.range[0]).toMatchObject({
      eventId: "event-range",
      providerSelection: PROVIDER_SELECTION,
    });
    expect(heard.appended).toHaveLength(1);
    expect(heard.appended[0]).toMatchObject({
      eventId: "event-live",
      providerSelection: PROVIDER_SELECTION,
    });
    client.close();
  });

  it("still delivers an event that carries no provenance, leaving the key absent", () => {
    const { client, session, heard } = openClient();

    session.deliver(snapshotEnvelope([chatEvent("event-tail", false)]));
    session.deliver(rangeEnvelope([chatEvent("event-range", false)]));
    session.deliver(eventAppendedEnvelope(chatEvent("event-live", false)));

    for (const delivered of [heard.snapshot, heard.range, heard.appended]) {
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).not.toHaveProperty("providerSelection");
    }
    client.close();
  });
});
