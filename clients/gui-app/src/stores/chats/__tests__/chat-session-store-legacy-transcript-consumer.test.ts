import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { ParamsOf } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  BUDGET_PLANE_IDS,
  type PlaneUsage,
} from "@traycer-clients/shared/replica-runtime";
import {
  createChatSessionStore,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  getProcessMemoryRuntime,
  type ProcessMemoryRuntime,
} from "@/stores/replica-memory/process-memory-accountant";
import { CHAT_WINDOWS_SOFT_LIMIT_BYTES } from "@/stores/replica-memory/budget-limits";
import {
  chatHolderId,
  chatWholeSetSliceBytes,
  legacyTranscriptResidencyBytes,
  type ChatWholeSetSlices,
} from "@/stores/replica-memory/chat-window-budget";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * The windowed (`chat.subscribe@1.8`) -> legacy (`chat.subscribe@1.0-1.7`)
 * downgrade, driven through the REAL consumer chain: a fake `IStreamSession`
 * feeds raw wire envelopes to a REAL `ChatStreamClient` - the actual Zod
 * schema parse and frame routing in `chat-stream-client.ts` - which drives
 * the store's REAL callbacks, which drive the REAL
 * `createLegacyChatTranscriptAdapter()` wired in `chat-session-store.ts`.
 * Nothing here calls `callbacks.onSnapshot(...)` directly.
 *
 * The legacy snapshot envelope below is a VERBATIM capture of what a real
 * `ChatSessionManager` puts on the wire for a `1.7` peer - taken from
 * `traycer-host/src/domain/chat/__tests__/chat-windowed-emit.test.ts`
 * ("chat.subscribe: a 1.7 peer and a 1.8 peer share one session" ->
 * `legacySnapshots.at(-1)`), by temporarily writing that test's
 * `lastLegacySnapshot` to disk and copying the JSON here. The capture command
 * was `cd traycer-host && bun run vitest run
 * src/domain/chat/__tests__/chat-windowed-emit.test.ts -t "fans a broadcast
 * out as a FULL snapshot"`. The JSON data was pasted without changing,
 * removing or reordering any field or value; only JSON-to-TypeScript
 * object-literal syntax/formatting differs. The OSS build cannot import
 * `@traycer/host` (internal package) to capture this frame live, so this is a
 * frozen point-in-time capture rather than a live replay - still real host
 * output, not an OSS-side reconstruction. The windowed priming snapshot below
 * has no such source and is a plain schema-shaped fixture; only the downgrade
 * frame carries capture provenance.
 */

// ─── A fake wire session that lets a REAL ChatStreamClient parse real bytes ─

class FakeChatWireSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  negotiatedVersion: SchemaVersion | null = null;

  readonly sentFrames: StreamFrameEnvelope[] = [];

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    this.sentFrames.push(envelope);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  requestReconnect(): void {
    // No-op: this harness drives reconnection by mutating
    // `negotiatedVersion` directly, mirroring a real renegotiated session.
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedVersion;
  }

  close(): void {
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  /** Feed a raw wire envelope through the REAL `ChatStreamClient` parse. */
  fireServerFrame(envelope: StreamFrameEnvelope): void {
    if (this.serverFrameHandler === null) {
      throw new Error("Expected ChatStreamClient to have installed a handler");
    }
    this.serverFrameHandler(envelope, null);
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }
}

class FakeChatStreamRpcClient implements IStreamClient<HostStreamRpcRegistry> {
  constructor(private readonly session: FakeChatWireSession) {}

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: () => ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    throw new Error(
      "FakeChatStreamRpcClient.subscribeWithParamsProvider is unused by ChatStreamClient",
    );
  }

  getMethodSchemaVersion<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
  ): SchemaVersion | null {
    return this.session.getNegotiatedSchemaVersion();
  }
}

const EPIC_ID = "epic-windowed-emit";
const CHAT_ID = "chat-windowed-emit";

const WINDOWED_VERSION: SchemaVersion = { major: 1, minor: 8 };
// The captured legacy envelope's own negotiated line - a `1.7` peer, the
// full-snapshot line the adapter's doc calls "`chat.subscribe@1.0-1.7`".
const LEGACY_VERSION: SchemaVersion = { major: 1, minor: 7 };

interface ConsumerHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly session: FakeChatWireSession;
}

function createConsumerHarness(): ConsumerHarness {
  const session = new FakeChatWireSession();
  session.negotiatedVersion = WINDOWED_VERSION;
  const client = new FakeChatStreamRpcClient(session);
  const captured: { chatStreamClient: ChatStreamClient | null } = {
    chatStreamClient: null,
  };

  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-1",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: "owner-1",
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (
      epicId: string,
      chatId: string,
      callbacks: ChatStreamCallbacks,
    ) => {
      const streamClient = new ChatStreamClient({
        wsStreamClient: client,
        epicId,
        chatId,
        callbacks,
      });
      captured.chatStreamClient = streamClient;
      return {
        sendAction: (frame) => streamClient.sendAction(frame),
        sameTurnSteeringProtocolSupported: () =>
          streamClient.sameTurnSteeringProtocolSupported(),
        requestTranscriptRange: (request) =>
          streamClient.requestTranscriptRange(request),
        requestResnapshot: () => streamClient.requestResnapshot(),
        interviewSettlementActionsProtocolSupported: () =>
          streamClient.interviewSettlementActionsProtocolSupported(),
        close: () => streamClient.close(),
      };
    },
  });

  if (captured.chatStreamClient === null) {
    throw new Error("Expected the store to construct a ChatStreamClient");
  }
  return { handle, session };
}

/**
 * A schema-shaped `chat.subscribe@1.8` snapshot with a non-trivial tail, so
 * the transition test starts from real, non-empty windowed state
 * (`rowCount`, a hydrated tail row, and `derived`). Not a capture - there is
 * no equivalent "single windowed peer" provenance test in the host suite this
 * harness can point at, and none of this object's shape is what the downgrade
 * test is proving.
 */
function windowedSnapshotEnvelope(): StreamFrameEnvelope {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: "owner-1",
        hostId: "host-1",
        title: "Windowed emit",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 1,
      managedCommands: [],
      heldUpdates: [],
      transcriptEpoch: 1,
      rowCount: 40,
      indexRevision: 1,
      tail: {
        fromOrdinal: 20,
        messages: [
          {
            role: "user",
            messageId: "tail-message",
            sender: { type: "user", userId: "owner-1" },
            message: {
              kind: "user",
              content: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "tail" }],
                  },
                ],
              },
              browserAnnotations: [],
            },
            timestamp: 20,
            sessionAnchor: null,
          },
        ],
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

/** Non-default windowed aux state that the legacy transition must clear. */
function accumulatedChangesEnvelope(): StreamFrameEnvelope {
  return {
    kind: "accumulatedChanges",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: 1,
      fromIndex: 0,
      generation: 1,
      summaries: [
        {
          filePath: "src/primed.ts",
          operation: "edit",
          diffSource: "snapshot",
          reason: "snapshot",
          undoable: true,
          hasContents: true,
          digest: "captured-transition-primer",
          counts: { additions: 1, deletions: 0 },
        },
      ],
      isFinal: true,
    },
  };
}

/**
 * Verbatim capture of `traycer-host/src/domain/chat/__tests__/chat-windowed-emit.test.ts`,
 * describe "chat.subscribe: a 1.7 peer and a 1.8 peer share one session",
 * `legacySnapshots.at(-1)` from a `1.7`-negotiated peer. See the file doc
 * comment above for how it was taken.
 */
function capturedLegacySnapshotEnvelope(): StreamFrameEnvelope {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-windowed-emit",
    chatId: "chat-windowed-emit",
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-windowed-emit",
        userId: "owner-1",
        hostId: "host-1",
        title: "Windowed emit",
        createdAt: 1000,
        updatedAt: 1787993069475,
        isTitleEditedByUser: false,
        settings: {
          harnessId: "claude",
          model: "test-model",
          permissionMode: "full_access",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
        activeSessionChain: {
          harnessId: "claude",
          sessionId: "session-1",
          sessionWorkspaceSnapshot: {
            workspaceKind: "session-snapshot",
            primaryWorkspace: "/tmp/project",
            secondaryWorkspaces: ["/tmp/traycer-home"],
          },
          coveredUntilMessageId: null,
          profileId: null,
        },
        claudePendingWakes: [],
        messages: [
          {
            role: "user",
            messageId: "message-1",
            sender: { type: "user", userId: "owner-1" },
            message: {
              kind: "user",
              content: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "hello" }],
                  },
                ],
              },
              browserAnnotations: [],
            },
            timestamp: 1787993069465,
            sessionAnchor: null,
          },
          {
            imageResolutions: [],
            role: "assistant",
            messageId: "995fb49c-8f9d-4252-b1fd-5258a3d2fe10",
            sender: {
              type: "agent",
              harnessId: "claude",
              agentId: "test-model",
              displayName: "test-model",
              reply: { expectsReply: false },
              inReplyTo: null,
            },
            blocks: [
              {
                type: "text",
                blockId: "block-1",
                status: "completed",
                timestamp: 2003,
                text: "ok",
                providerNotice: null,
              },
            ],
            startedAt: 1787993069468,
            blocksVersion: 2,
            timestamp: 1787993069475,
            turnId: "turn-1",
            usage: null,
            reasoningEffort: null,
            serviceTier: null,
          },
        ],
        events: [
          {
            eventId: "f321df26-d6b2-47d4-b85c-2678f1c44b70",
            type: "send.accepted",
            timestamp: 1787993069466,
            clientActionId: "send-1",
            actor: { type: "user", userId: "owner-1" },
            message: "Message accepted.",
            turnId: null,
            messageId: "message-1",
            queueItemId: null,
            approvalId: null,
            blockId: null,
            severity: "info",
            metadata: null,
          },
          {
            eventId: "7c22ee6e-1e5f-4bab-bbb3-9e5bfc9e9db1",
            type: "turn.started",
            timestamp: 1787993069472,
            clientActionId: null,
            actor: null,
            message: "Turn started.",
            turnId: "turn-1",
            messageId: "message-1",
            queueItemId: null,
            approvalId: null,
            blockId: null,
            severity: "info",
            metadata: null,
          },
          {
            eventId: "403534a2-a463-409e-be35-1f15f76e565e",
            type: "turn.completed",
            timestamp: 1787993069474,
            clientActionId: null,
            actor: null,
            message: "Turn completed.",
            turnId: "turn-1",
            messageId: "message-1",
            queueItemId: null,
            approvalId: null,
            blockId: null,
            severity: "info",
            metadata: null,
          },
        ],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: {
        entries: [
          {
            workspacePath: "/tmp/project",
            mode: "local",
            repoIdentifier: null,
            worktreePath: null,
            branch: null,
            isPrimary: true,
            isImported: false,
            setupState: "not_required",
            setupTerminalSessionId: null,
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: 1,
            ownedSubmodules: [],
          },
        ],
      },
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      backgroundItems: [],
      managedCommands: [],
      heldUpdates: [],
      turnInProgress: false,
    },
  };
}

/** A stale `range` answer for the coordinate space the downgrade abandoned. */
function strandedRangeEnvelope(): StreamFrameEnvelope {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: "straggler",
      epoch: 1,
      fromOrdinal: 10,
      rowIds: ["row-10", "row-11"],
      messages: [],
      events: [],
      rowContext: {},
      reachedStart: false,
      reachedEnd: false,
    },
  };
}

describe("chat-session-store - real windowed -> legacy transcript downgrade", () => {
  it("atomically replaces windowed state with the captured legacy transcript, in one notification", () => {
    const harness = createConsumerHarness();
    try {
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(windowedSnapshotEnvelope());
      harness.session.fireServerFrame(accumulatedChangesEnvelope());
      harness.handle.store.getState().requestTranscriptOrdinal(10);

      const primed = harness.handle.store.getState();
      expect(primed.transcriptWindow.rowCount).toBe(40);
      expect(primed.transcriptDerived).not.toBeNull();
      expect(primed.accumulatedFileChangeCount).toBe(1);
      expect(primed.accumulatedFileChangeSummaries).toHaveLength(1);
      expect(primed.accumulatedSummaryGenerationSeated).toBe(true);
      expect(primed.jumpTargetOrdinal).toBe(10);
      expect(primed.messages.map((message) => message.messageId)).toEqual([
        "tail-message",
      ]);

      // The physical stream reconnects and renegotiates onto the older line.
      // Subscribe to store notifications only AFTER the transport-status
      // transitions: this assertion is specifically that the data-plane swap
      // itself publishes one indivisible state.
      harness.session.emitStatus("reconnecting", null);
      harness.session.negotiatedVersion = LEGACY_VERSION;
      harness.session.emitStatus("open", null);
      let notifications = 0;
      const unsubscribe = harness.handle.store.subscribe(() => {
        notifications += 1;
      });
      harness.session.fireServerFrame(capturedLegacySnapshotEnvelope());
      unsubscribe();

      // Every window/derived/aux clear plus the new transcript's publish
      // land in the SAME `set()` - one downstream re-render, not a beat of
      // "new transcript, old window still showing" in between.
      expect(notifications).toBe(1);

      const afterDowngrade = harness.handle.store.getState();
      expect(afterDowngrade.transcriptWindow.rowCount).toBe(0);
      expect(afterDowngrade.transcriptDerived).toBeNull();
      expect(afterDowngrade.accumulatedFileChangeCount).toBe(0);
      expect(afterDowngrade.jumpTargetOrdinal).toBeNull();
      expect(afterDowngrade.accumulatedFileChangeSummaries).toEqual([]);
      expect(afterDowngrade.accumulatedSummaryGenerationSeated).toBe(false);
      // The captured legacy transcript is what actually rendered - the
      // windowed tail row is gone, replaced wholesale.
      expect(
        afterDowngrade.messages.map((message) => message.messageId),
      ).toEqual(["message-1", "995fb49c-8f9d-4252-b1fd-5258a3d2fe10"]);
      expect(JSON.stringify(afterDowngrade.messages)).toContain("hello");
      expect(JSON.stringify(afterDowngrade.messages)).toContain("ok");
      expect(afterDowngrade.events.map((event) => event.type)).toEqual([
        "send.accepted",
        "turn.started",
        "turn.completed",
      ]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a windowed frame that reaches the consumer after the downgrade remains inert", () => {
    const harness = createConsumerHarness();
    try {
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(windowedSnapshotEnvelope());
      harness.session.emitStatus("reconnecting", null);
      harness.session.negotiatedVersion = LEGACY_VERSION;
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(capturedLegacySnapshotEnvelope());

      const beforeStraggler = harness.handle.store.getState();
      let notifications = 0;
      const unsubscribe = harness.handle.store.subscribe(() => {
        notifications += 1;
      });

      // Route the envelope through the windowed union deliberately: this makes
      // the REAL `ChatStreamClient` parse and deliver it, so the assertion is
      // about the store consumer's abandoned-line latch rather than about a
      // legacy-schema rejection one layer earlier. T4 owns the independent
      // retired-stream-generation guard.
      harness.session.negotiatedVersion = WINDOWED_VERSION;
      harness.session.fireServerFrame(strandedRangeEnvelope());
      unsubscribe();

      const afterStraggler = harness.handle.store.getState();
      expect(notifications).toBe(0);
      expect(afterStraggler).toBe(beforeStraggler);
    } finally {
      harness.handle.dispose();
    }
  });
});

// ─── T5's process-wide chat-windows holder, driven by the same real frames ─

function sixWholeSetSlicesOf(state: ChatSessionState): ChatWholeSetSlices {
  return {
    queue: state.queue,
    pendingApprovals: state.pendingApprovals,
    pendingFileEditApprovals: state.pendingFileEditApprovals,
    pendingInterviews: state.pendingInterviews,
    backgroundItems: state.backgroundItems,
    managedCommands: state.managedCommands,
  };
}

/**
 * The independently-recomputed legacy charge: the two EXPORTED building
 * blocks (`legacyTranscriptResidencyBytes`, `chatWholeSetSliceBytes`) summed
 * here, in the test - not the production module's own private
 * `legacyTranscriptChargeBytes`, which this file cannot import.
 */
function expectedLegacyChargeBytes(state: ChatSessionState): number {
  return (
    legacyTranscriptResidencyBytes(state.messages, state.events) +
    chatWholeSetSliceBytes(sixWholeSetSlicesOf(state))
  );
}

function chatWindowsUsage(memory: ProcessMemoryRuntime): PlaneUsage {
  const usage = memory.accountant
    .snapshot()
    .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.chatWindows);
  if (usage === undefined) {
    throw new Error("Expected the chat-windows plane to be registered");
  }
  return usage;
}

describe("chat-session-store - real legacy snapshots settle the process-wide chat-windows holder", () => {
  it("a steady (non-downgrade) legacy snapshot settles to legacy residency + the six whole-set slices, with exactly one holder", () => {
    const memory = getProcessMemoryRuntime();
    const harness = createConsumerHarness();
    try {
      // Negotiated at the legacy line from the very first frame - `windowedLine`
      // never becomes true, so this exercises `applyLegacyTranscriptEvent`'s
      // `!windowedLine` branch (`commitLegacyTranscriptBudget()` at its OWN call
      // site), not the downgrade branch below.
      harness.session.negotiatedVersion = LEGACY_VERSION;
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(capturedLegacySnapshotEnvelope());

      const state = harness.handle.store.getState();
      const expectedBytes = expectedLegacyChargeBytes(state);
      // Non-vacuous: the captured transcript's two messages + three events
      // alone make this fail on a `0` remeasurement.
      expect(expectedBytes).toBeGreaterThan(0);

      const usage = chatWindowsUsage(memory);
      expect(usage.settledBytes).toBe(expectedBytes);
      expect(usage.holderCount).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("the windowed -> legacy downgrade settles to the legacy amount, proven distinct from the prior windowed amount", () => {
    const memory = getProcessMemoryRuntime();
    const harness = createConsumerHarness();
    try {
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(windowedSnapshotEnvelope());

      const windowedSettledBytes = chatWindowsUsage(memory).settledBytes;
      expect(windowedSettledBytes).toBeGreaterThan(0);

      harness.session.emitStatus("reconnecting", null);
      harness.session.negotiatedVersion = LEGACY_VERSION;
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(capturedLegacySnapshotEnvelope());

      const state = harness.handle.store.getState();
      const expectedLegacyBytes = expectedLegacyChargeBytes(state);

      const usage = chatWindowsUsage(memory);
      // A missing legacy settle (the downgrade branch's OWN
      // `commitLegacyTranscriptBudget()` call, distinct from the steady
      // branch's) would leave the stale windowed figure standing, which
      // `toBe(expectedLegacyBytes)` alone could still coincidentally pass if
      // the two figures happened to collide - proving they differ first is
      // what rules that out.
      expect(usage.settledBytes).not.toBe(windowedSettledBytes);
      expect(usage.settledBytes).toBe(expectedLegacyBytes);
      expect(usage.holderCount).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a real legacy snapshot that pushes chat-windows over budget settles the sole-copy amount, requests one eviction, reclaims nothing, and latches over-protected", () => {
    const memory = getProcessMemoryRuntime();
    // An accountant-only primer: settled directly, never attached to
    // `memory.chatWindows`, so the book's own eviction sweep (which only
    // visits ATTACHED sessions) can never touch it - it exists purely to push
    // the plane to exactly the soft limit before the real chat holder adds
    // anything.
    const primerHolderId = "primer:chat-windows-pressure-path";
    memory.accountant.settle(
      BUDGET_PLANE_IDS.chatWindows,
      primerHolderId,
      CHAT_WINDOWS_SOFT_LIMIT_BYTES,
    );
    // Cumulative telemetry (evictionsRequested/bytesReclaimed) is process-wide
    // and never reset between tests, so every assertion on it below reads a
    // DELTA off this pre-snapshot baseline rather than an absolute value.
    const baseline = chatWindowsUsage(memory);
    const harness = createConsumerHarness();
    try {
      harness.session.negotiatedVersion = LEGACY_VERSION;
      harness.session.emitStatus("open", null);
      harness.session.fireServerFrame(capturedLegacySnapshotEnvelope());

      const state = harness.handle.store.getState();
      const expectedLegacyBytes = expectedLegacyChargeBytes(state);
      expect(expectedLegacyBytes).toBeGreaterThan(0);

      const usage = chatWindowsUsage(memory);
      expect(usage.settledBytes - CHAT_WINDOWS_SOFT_LIMIT_BYTES).toBe(
        expectedLegacyBytes,
      );
      expect(usage.evictionsRequested - baseline.evictionsRequested).toBe(1);
      expect(usage.bytesReclaimed - baseline.bytesReclaimed).toBe(0);
      // Asserted BEFORE the direct `chatWindows.evict()` probe below: that
      // probe re-settles the same holder as a side effect, which clears the
      // accountant's `protectedLatch` outside `accountant.reconcile()` and
      // would make this read `"over"` (or better) instead of the terminal
      // state production's own `commitLegacyTranscriptBudget()` -> `reconcile`
      // actually left the plane in.
      expect(memory.accountant.pressure(BUDGET_PLANE_IDS.chatWindows)).toBe(
        "over-protected",
      );

      // Diagnostic-only, and deliberately last: call the book's eviction sweep
      // directly to inspect what it told the accountant, rather than
      // re-deriving it from private state. The legacy branch's `evict` never
      // reads `overBytes` (there is no ordinal/range to evict a PART of), so
      // any positive value drives the same outcome.
      const transcriptBytes = legacyTranscriptResidencyBytes(
        state.messages,
        state.events,
      );
      // Deliberately falsify only this holder's ledger while leaving the
      // resident transcript untouched. The direct eviction probe must
      // remeasure and restore the whole legacy charge; without the legacy
      // branch's own `settle`, its zero-reclaimed outcome could otherwise pass
      // while merely inheriting the correct landing-time charge.
      memory.accountant.settle(
        BUDGET_PLANE_IDS.chatWindows,
        chatHolderId("host-1", EPIC_ID, CHAT_ID),
        0,
      );
      const outcome = memory.chatWindows.evict(1);
      expect(outcome.reclaimedBytes).toBe(0);
      expect(outcome.protectedBytesByKind).toEqual([
        { kind: "sole-copy", bytes: transcriptBytes },
      ]);
      expect(
        chatWindowsUsage(memory).settledBytes - CHAT_WINDOWS_SOFT_LIMIT_BYTES,
      ).toBe(expectedLegacyBytes);
    } finally {
      harness.handle.dispose();
      memory.accountant.release(BUDGET_PLANE_IDS.chatWindows, primerHolderId);
    }
  });
});
