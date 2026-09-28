/**
 * The store's own `SendTimings` recorder marks one of three "pending row
 * reconciliation doors" whenever a previously-pending optimistic user message
 * stops being pending (`chat-session-store.ts`'s `unsubscribeSendTimings`
 * store subscription): `pending_replaced_by_acceptance` (the host's own
 * `messageAccepted` frame already reached this connection - `acceptance_received`
 * was marked before the pending-row filter ran, and that takes PRIORITY over
 * the other two), `pending_replaced_by_transcript` (a transcript row landed
 * with the same message id through some other path, with no
 * `acceptance_received` mark on file), `pending_replaced_by_queue` (the host
 * reports it queued instead), or `pending_removed` (it disappeared for some
 * other reason, e.g. rejection). The priority check is IDENTICAL for the
 * windowed and legacy transcript lines - it reads `state.pendingUserMessages`
 * only, never `state.messages` - so one narrow windowed-line test below
 * exists to prove that priority is not accidentally legacy-only.
 *
 * This suite drives that subscription through a REAL store via the same
 * legacy harness `chat-session-store-message-delivery-lifecycle.test.ts`
 * uses, and reads the phases out of `appLogger.info("ChatSendTiming", {entries,
 * droppedEntries})` calls - the recorder's actual emit sink in the GUI (see
 * `createChatSessionStoreWithNotificationDependencies`), chunked at 20 entries
 * per call. `SendTimings` only BUFFERS on `mark()`; the batch is not visible on
 * the spy until the ~1s auto-flush actually emits it (there is no public flush
 * hook on `ChatSessionStoreHandle`), so every phase assertion here waits for it
 * via `vi.waitFor` under real timers rather than reading the spy synchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  SendTimingBatch,
  SendTimingEntry,
} from "@traycer/protocol/host/agent/gui/send-timing";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { appLogger } from "@/lib/logger";

const EPIC_ID = "epic-send-timing";
const CHAT_ID = "chat-send-timing";
const OWNER_ID = "owner-send-timing";
const HOST_ID = "host-send-timing";

const SEND_TIMING_LOCAL_STORAGE_KEY = "traycer:send-timing";
const ORIGINAL_SEND_TIMING_LOCAL_STORAGE_VALUE = localStorage.getItem(
  SEND_TIMING_LOCAL_STORAGE_KEY,
);

// The store reads this gate ONCE, at `createChatSessionStore()` construction,
// so it must already be "1" before `createHarness()` builds the store below.
beforeEach(() => {
  localStorage.setItem(SEND_TIMING_LOCAL_STORAGE_KEY, "1");
});

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function emptyChat(): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: HOST_ID,
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function emitSnapshot(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: emptyChat(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
    },
  });
}

/** A minimal WINDOWED-line bootstrap snapshot: no `chat.messages`/`events`. */
type WindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];

function emitWindowedSnapshot(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null, null);
  const frame: WindowedSnapshotFrame = {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: HOST_ID,
        title: "Chat",
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
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
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
  callbacks.onWindowedSnapshot(frame);
}

function sendPrompt(harness: Harness): {
  readonly clientActionId: string;
  readonly messageId: string;
} {
  const action = harness.handle.store.getState().sendMessage({
    content: CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: [],
    deliveryPolicy: "auto",
    restore: { content: CONTENT, browserAnnotations: [] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  return action;
}

/**
 * Acceptance carries a user message, not the broader transcript Message union.
 */
type AcceptedMessage = Parameters<
  ChatStreamCallbacks["onMessageAccepted"]
>[0]["message"];

function acceptedMessage(
  messageId: string,
  timestamp: number,
): AcceptedMessage {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function emitMessageAccepted(
  callbacks: ChatStreamCallbacks,
  message: AcceptedMessage,
): void {
  callbacks.onMessageAccepted({
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    message,
  });
}

function queuedPromptItem(messageId: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: `queue-${messageId}`,
    messageId,
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function emitQueueChanged(
  callbacks: ChatStreamCallbacks,
  items: ChatQueuedPromptItem[],
): void {
  callbacks.onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: items.length > 0 ? "running" : "idle", items },
  });
}

function isSendTimingBatchLike(
  value: unknown,
): value is Pick<SendTimingBatch, "entries"> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "entries"))
  );
}

function sendTimingEntriesFor(
  calls: readonly (readonly unknown[])[],
  messageId: string,
): SendTimingEntry[] {
  return calls
    .filter((call) => call[0] === "ChatSendTiming")
    .map((call) => call[1])
    .filter(isSendTimingBatchLike)
    .flatMap((batch) => batch.entries)
    .filter((entry) => entry.messageId === messageId);
}

function sendTimingPhasesFor(
  calls: readonly (readonly unknown[])[],
  messageId: string,
): string[] {
  return sendTimingEntriesFor(calls, messageId).map((entry) => entry.phase);
}

let harness: Harness | null = null;
// Takes the raw `mock.calls` rather than the spy itself: naming the spy's
// type means `ReturnType<typeof vi.spyOn>`, which this package's ESLint bans
// outright (see `report-issue-action-analytics.test.tsx`'s doc comment).
let infoCalls: readonly (readonly unknown[])[] = [];

beforeEach(() => {
  const info = vi.spyOn(appLogger, "info").mockImplementation(() => {});
  infoCalls = info.mock.calls;
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
  vi.restoreAllMocks();
  infoCalls = [];
  if (ORIGINAL_SEND_TIMING_LOCAL_STORAGE_VALUE === null) {
    localStorage.removeItem(SEND_TIMING_LOCAL_STORAGE_KEY);
  } else {
    localStorage.setItem(
      SEND_TIMING_LOCAL_STORAGE_KEY,
      ORIGINAL_SEND_TIMING_LOCAL_STORAGE_VALUE,
    );
  }
});

function loggedCalls(): readonly (readonly unknown[])[] {
  return infoCalls;
}

/** Waits (real timers) for `messageId` to have recorded `phase` at least once. */
async function waitForPhase(messageId: string, phase: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(sendTimingPhasesFor(loggedCalls(), messageId)).toContain(phase);
    },
    { timeout: 2_000, interval: 50 },
  );
}

/**
 * Waits for `phase` to have recorded at least `count` occurrences. Needed
 * where a phase can legitimately recur (`transport_closed` marks on EVERY
 * disconnect, not just the first) and a bare `waitForPhase` would resolve on
 * the FIRST occurrence's flush - stale for an assertion that means to read
 * state as of the SECOND.
 */
async function waitForOccurrenceCount(
  messageId: string,
  phase: string,
  count: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      const occurrences = sendTimingPhasesFor(loggedCalls(), messageId).filter(
        (recorded) => recorded === phase,
      ).length;
      expect(occurrences).toBeGreaterThanOrEqual(count);
    },
    { timeout: 2_000, interval: 50 },
  );
}

describe("ChatSendTiming pending-row reconciliation (GUI store)", () => {
  it("marks 'pending_replaced_by_acceptance' (not '_by_transcript') once the host's own messageAccepted frame reaches this connection, on the LEGACY line", async () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks);
    const sent = sendPrompt(harness);
    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(true);

    emitMessageAccepted(callbacks, acceptedMessage(sent.messageId, 10));

    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(false);
    expect(
      harness.handle.store
        .getState()
        .messages.some((m) => m.messageId === sent.messageId),
    ).toBe(true);

    await waitForPhase(sent.messageId, "pending_replaced_by_acceptance");
    const phases = sendTimingPhasesFor(loggedCalls(), sent.messageId);
    // Acceptance takes PRIORITY: a transcript row landing alongside the same
    // `messageAccepted` frame must not ALSO fire the transcript door.
    expect(phases).not.toContain("pending_replaced_by_transcript");
    expect(phases).not.toContain("pending_replaced_by_queue");
    expect(phases).not.toContain("pending_removed");
  });

  it("marks 'pending_replaced_by_acceptance' on the WINDOWED line too - the priority check reads pendingUserMessages only, never state.messages", async () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitWindowedSnapshot(callbacks);
    const sent = sendPrompt(harness);
    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(true);

    emitMessageAccepted(callbacks, acceptedMessage(sent.messageId, 10));

    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(false);

    await waitForPhase(sent.messageId, "pending_replaced_by_acceptance");
    const phases = sendTimingPhasesFor(loggedCalls(), sent.messageId);
    expect(phases).not.toContain("pending_replaced_by_transcript");
    expect(phases).not.toContain("pending_replaced_by_queue");
    expect(phases).not.toContain("pending_removed");
  });

  it("marks 'pending_replaced_by_queue' when the host reports the message queued instead of accepted into the transcript", async () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks);
    const sent = sendPrompt(harness);

    emitQueueChanged(callbacks, [queuedPromptItem(sent.messageId)]);

    expect(
      harness.handle.store
        .getState()
        .messages.some((m) => m.messageId === sent.messageId),
    ).toBe(false);

    await waitForPhase(sent.messageId, "pending_replaced_by_queue");
    const phases = sendTimingPhasesFor(loggedCalls(), sent.messageId);
    expect(phases).not.toContain("pending_replaced_by_acceptance");
    expect(phases).not.toContain("pending_replaced_by_transcript");
    expect(phases).not.toContain("pending_removed");
  });

  it("a disconnect (reconnecting/closed) marks 'transport_closed' on the pending action, but never falsely clears Pending: the row survives and no reconciliation-door phase fires", async () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks);
    const sent = sendPrompt(harness);

    callbacks.onConnectionStatus("reconnecting", null, null);

    // The row is still there: a lost connection is not a reconciliation
    // event, and this store never speculatively drops an optimistic row.
    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(true);

    await waitForPhase(sent.messageId, "transport_closed");
    const phases = sendTimingPhasesFor(loggedCalls(), sent.messageId);
    expect(phases).not.toContain("pending_replaced_by_acceptance");
    expect(phases).not.toContain("pending_replaced_by_transcript");
    expect(phases).not.toContain("pending_replaced_by_queue");
    expect(phases).not.toContain("pending_removed");

    callbacks.onConnectionStatus("closed", null, null);
    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(true);
    // "reconnecting" above already recorded one `transport_closed`; wait for
    // the SECOND (this "closed" call's own mark) rather than reading
    // `loggedCalls()` immediately, which would just re-observe the first
    // occurrence's already-flushed batch and say nothing about this call.
    await waitForOccurrenceCount(sent.messageId, "transport_closed", 2);
    const phasesAfterClose = sendTimingPhasesFor(loggedCalls(), sent.messageId);
    expect(phasesAfterClose).not.toContain("pending_removed");

    // The row is still reconcilable once the host actually confirms it, i.e.
    // disconnect only delayed the door, never bypassed it.
    emitMessageAccepted(callbacks, acceptedMessage(sent.messageId, 10));
    await waitForPhase(sent.messageId, "pending_replaced_by_acceptance");
  });
});
