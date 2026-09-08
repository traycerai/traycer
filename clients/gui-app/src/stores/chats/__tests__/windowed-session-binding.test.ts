import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatAccumulatedFileChangeSummary,
  ChatLoadRangeRequest,
  InterviewAnswerability,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { createImageResolutionUpdatedFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  assistantRowId,
  assistantSliceRowId,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  createChatSessionStore,
  MAX_PROVISIONAL_CATCH_UP_ROUNDS,
  STREAM_COMPLETION_TIMEOUT_MS,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { appLogger } from "@/lib/logger";
import {
  IMMEDIATE_STREAM_FLUSH_COORDINATOR,
  type StreamFlushCoordinator,
} from "@/stores/chats/stream-flush-coordinator";
import {
  isTailHydrated,
  spanMessages,
  TRANSCRIPT_WINDOW_MAX_BYTES,
} from "@/stores/chats/transcript-window";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * # The wait-for-tail rule
 *
 * The session store's authoritative-snapshot fold decides, among other things,
 * whether a pending send ever landed - and it decides by looking for it in the
 * records it was handed. On the legacy line that question is sound because the
 * snapshot carries the whole transcript. On the windowed line it is not:
 * `messages` holds what is HYDRATED, so "absent" can mean "not fetched yet".
 *
 * Getting that wrong restores an already-sent message into the composer and the
 * user sends it twice, which is worse than any rendering bug in this feature.
 * These tests pin the sequencing that prevents it.
 *
 * The frames are delivered straight to the store's callbacks rather than
 * through a negotiated stream. That is deliberate rather than a shortcut: this
 * behaviour lives on the callback surface, and driving it directly is what lets
 * a test place an `indexChanged` between a `loadRange` and its answer - the
 * reordering these fixtures exist to pin, and one a real handshake gives no way
 * to schedule.
 */

const EPIC_ID = "epic-w";
const CHAT_ID = "chat-w";
const OWNER_ID = "owner-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

/**
 * The `messageAccepted` frame's own message type. NOT the `Message` below: the
 * two are structurally identical and nominally distinct (the frame's resolves
 * through the subscribe union's schema instance), so a fixture typed as one
 * cannot be passed where the other is expected.
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

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

/**
 * One row larger than the whole window budget.
 *
 * A legal response: the host's range read always serves the FIRST requested row
 * whatever it costs (`read-range.ts`), so a single oversized row is exactly how
 * a window ends up over budget with nothing else to blame.
 */
function oversizedMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x".repeat(TRANSCRIPT_WINDOW_MAX_BYTES + 1),
              },
            ],
          },
        ],
      },
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
  };
}

function assistantMessage(messageId: string, timestamp: number): Message {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

type AssistantBlocks = Extract<Message, { role: "assistant" }>["blocks"];

function assistantWithBlocks(
  messageId: string,
  timestamp: number,
  turnId: string,
  blocks: AssistantBlocks,
): Message {
  const base = assistantMessage(messageId, timestamp);
  return base.role === "assistant" ? { ...base, turnId, blocks } : base;
}

function raiseActiveTurn(callbacks: ChatStreamCallbacks, turnId: string): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "running",
    activeTurn: {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId,
      status: "running",
      harnessId: "codex",
      model: "gpt-5.4",
      profileId: null,
      userMessageId: "m-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    },
  });
}

function completeActiveTurn(callbacks: ChatStreamCallbacks): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
  });
}

function blockOf(
  message: Message | undefined,
  blockId: string,
): AssistantBlocks[number] | undefined {
  if (message === undefined || message.role !== "assistant") return undefined;
  return message.blocks.find((block) => block.blockId === blockId);
}

function appendedEvent(
  eventId: string,
): Parameters<ChatStreamCallbacks["onEventAppended"]>[0] {
  return {
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    event: {
      eventId,
      type: "turn.completed",
      timestamp: 9,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: "turn-1",
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    },
  };
}

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  readonly resnapshotCount: () => number;
  callbacks(): ChatStreamCallbacks;
  /**
   * The id a `range` frame must carry to be seated.
   *
   * The store discards a response that does not answer its outstanding
   * request, so a fixture inventing an id would be testing the discard path
   * rather than the seat path. Throws when nothing is outstanding, because
   * that is a frame the host has no reason to send.
   */
  lastRangeRequestId(): string;
  /**
   * How many times the store asked the app to refetch `providers.list`.
   *
   * The re-auth banner's only trigger on a snapshot path, and on this line it
   * can no longer be read out of the published records.
   */
  providerAuthNudgeCount(): number;
}

/**
 * A harness whose stream deltas are NOT applied at the moment they arrive.
 *
 * The real coordinator coalesces: a delta frame is buffered on receipt and
 * folded on a later tick. `IMMEDIATE_STREAM_FLUSH_COORDINATOR` collapses that
 * interval to nothing, which is what most of these tests want - but it is also
 * an interval a range answer can land inside, and a body seated there is
 * folding into a window that has not yet absorbed the writes the client already
 * holds. `flushDeltas()` is that tick, under the test's control.
 */
interface DeferredFlushHarness extends WindowedHarness {
  readonly flushDeltas: () => void;
}

function createDeferredFlushHarness(): DeferredFlushHarness {
  let pendingFlush: (() => void) | null = null;
  const harness = createHarnessWith({
    register: (input) => {
      pendingFlush = input.flush;
      return {
        requestFlush: () => {},
        setVisible: () => {},
        unregister: () => {
          pendingFlush = null;
        },
      };
    },
  });
  return {
    ...harness,
    flushDeltas: () => {
      if (pendingFlush !== null) pendingFlush();
    },
  };
}

function createWindowedHarness(): WindowedHarness {
  return createHarnessWith(IMMEDIATE_STREAM_FLUSH_COORDINATOR);
}

function createHarnessWith(
  streamFlushCoordinator: StreamFlushCoordinator,
): WindowedHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let resnapshots = 0;
  let providerAuthNudges = 0;
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: () => {
      providerAuthNudges += 1;
    },
    streamFlushCoordinator,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: (request) => {
          rangeRequests.push(request);
        },
        requestResnapshot: () => {
          resnapshots += 1;
        },
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    rangeRequests,
    resnapshotCount: () => resnapshots,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
    lastRangeRequestId: () => {
      const last = rangeRequests.at(-1);
      if (last === undefined) throw new Error("Expected an outstanding range");
      return last.requestId;
    },
    providerAuthNudgeCount: () => providerAuthNudges,
  };
}

type WindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];

/**
 * Overlay the two aux/derived fields the answers below travel on.
 *
 * A patch rather than more parameters on {@link windowedSnapshot}: these are
 * read by two suites out of a dozen, and threading them through every call site
 * would say they are part of what a snapshot IS rather than something a
 * particular case sets.
 */
function withPendingQuestion(
  frame: WindowedSnapshotFrame,
  input: {
    readonly pendingInterviews: ReadonlyArray<{
      readonly blockId: string;
      readonly requestedAt: number;
    }>;
    readonly interviewAnswerability: ReadonlyArray<InterviewAnswerability>;
  },
): WindowedSnapshotFrame {
  return {
    ...frame,
    snapshot: {
      ...frame.snapshot,
      pendingInterviews: input.pendingInterviews.map((interview) => ({
        ...interview,
      })),
      derived: {
        ...frame.snapshot.derived,
        interviewAnswerability: input.interviewAnswerability.map((entry) => ({
          ...entry,
        })),
      },
    },
  };
}

function withAuthFailure(
  frame: WindowedSnapshotFrame,
  latestAssistantAuthFailureTurnKey: string | null,
): WindowedSnapshotFrame {
  return {
    ...frame,
    snapshot: {
      ...frame.snapshot,
      derived: {
        ...frame.snapshot.derived,
        latestAssistantAuthFailureTurnKey,
      },
    },
  };
}

function windowedSnapshot(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly tailFromOrdinal: number;
  readonly tailMessages: readonly Message[];
  readonly accumulatedFileChangeCount: number;
  /**
   * Defaults to `null` - "the host holds no index for this subscriber and is
   * rebuilding one", which resets the summary generation. Pass a live revision
   * for an AUX-ONLY re-broadcast, the case that carries no chunks and so must
   * leave a generation mid-assembly alone.
   */
  readonly indexRevision?: number | null;
}): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "host-a",
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
      accumulatedFileChangeCount: input.accumulatedFileChangeCount,
      managedCommands: [],
      heldUpdates: [],
      transcriptEpoch: input.epoch,
      rowCount: input.rowCount,
      indexRevision: input.indexRevision ?? null,
      tail: {
        fromOrdinal: input.tailFromOrdinal,
        messages: [...input.tailMessages],
        events: [],
      },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: "assistant-9",
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

describe("windowed snapshot with a hydrated tail", () => {
  it("applies the shared fold immediately and publishes the tail", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 3,
          tailFromOrdinal: 1,
          tailMessages: [userMessage("m-1", 1), userMessage("m-2", 2)],
          accumulatedFileChangeCount: 7,
        }),
      );

      const state = harness.handle.store.getState();
      expect(state.snapshotLoaded).toBe(true);
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-1",
        "m-2",
      ]);
      expect(state.transcriptWindow.rowCount).toBe(3);
      expect(state.transcriptWindow.epoch).toBe(4);
      // Host-computed folds a windowed client cannot derive for itself.
      expect(state.transcriptDerived?.latestForkableAssistantMessageId).toBe(
        "assistant-9",
      );
      expect(state.accumulatedFileChangeCount).toBe(7);
      // Nothing missing, so nothing asked for.
      expect(harness.rangeRequests).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * The two answers a windowed client can no longer read out of an ABSENCE.
 *
 * Both consumers used to take an irreversible action on "I cannot find it in
 * `messages`" - one offers to error out a question, the other declines to
 * invalidate a stale provider query - and on this line that array is the
 * hydrated subset.
 */
describe("host answers a windowed client cannot derive", () => {
  it("hydrates the row a cold pending question lives on", () => {
    // The tail is complete, the reader is looking at nothing in particular,
    // and ordinal 4 is far outside the window. No scroll would ever ask for
    // it - the answer card renders in the COMPOSER - so without the required
    // obligation the chat sits blocked with the question invisible.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        withPendingQuestion(
          windowedSnapshot({
            epoch: 4,
            rowCount: 30,
            tailFromOrdinal: 29,
            tailMessages: [userMessage("m-29", 29)],
            accumulatedFileChangeCount: 0,
          }),
          {
            pendingInterviews: [{ blockId: "ask-1", requestedAt: 10 }],
            interviewAnswerability: [{ blockId: "ask-1", ordinal: 4 }],
          },
        ),
      );

      expect(harness.rangeRequests).toHaveLength(1);
      const request = harness.rangeRequests[0];
      expect(request.epoch).toBe(4);
      expect(request.fromOrdinal).toBe(4);
      // Inclusive on the wire, so one row is `[4, 4]`.
      expect(request.toOrdinal).toBe(4);
    } finally {
      harness.handle.dispose();
    }
  });

  it("asks for nothing when the host says no row renders the question", () => {
    // `ordinal: null` is the genuinely-stuck judgement. There is no row to
    // fetch, and the composer's dismiss notice is the correct affordance -
    // fetching anything here would be a request with no answer.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        withPendingQuestion(
          windowedSnapshot({
            epoch: 4,
            rowCount: 30,
            tailFromOrdinal: 29,
            tailMessages: [userMessage("m-29", 29)],
            accumulatedFileChangeCount: 0,
          }),
          {
            pendingInterviews: [{ blockId: "ask-1", requestedAt: 10 }],
            interviewAnswerability: [{ blockId: "ask-1", ordinal: null }],
          },
        ),
      );

      expect(harness.rangeRequests).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("asks for nothing for a placed question that is no longer pending", () => {
    // The judgement and the pending set are one pair at the snapshot that
    // produced them, and they diverge afterwards: an interview settled by a
    // live frame leaves `pendingInterviews` immediately while the derived
    // payload keeps naming its row until the next snapshot. Fetching that row
    // is work with nothing on the other end of it.
    //
    // ANOTHER question stays pending on purpose. With an empty pending list
    // this would pass on the store's "nothing is pending" early return and
    // assert nothing about the intersection - which is exactly what the first
    // version of this test did.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        withPendingQuestion(
          windowedSnapshot({
            epoch: 4,
            rowCount: 30,
            tailFromOrdinal: 29,
            tailMessages: [userMessage("m-29", 29)],
            accumulatedFileChangeCount: 0,
          }),
          {
            pendingInterviews: [{ blockId: "ask-2", requestedAt: 20 }],
            interviewAnswerability: [
              { blockId: "ask-1", ordinal: 4 },
              { blockId: "ask-2", ordinal: null },
            ],
          },
        ),
      );

      expect(harness.rangeRequests).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("never evicts the question's row, on either path that runs the budget", () => {
    // The re-fetch loop in its purest form. A required ordinal is re-planned
    // with NO viewport to scroll away from, so a required span evicted as
    // coldest is re-requested immediately, evicted again, and the client
    // fetches one row forever. Both callers of the budget have to know:
    // `onRange`, which seats it, and `onWindowedSnapshot`, which runs on every
    // history mutation.
    //
    // One oversized row puts the window over budget on its own - a legal
    // response, since the host always serves the first requested row whatever
    // it costs - and nothing is visible throughout, so only the required rule
    // can save the span.
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      const question = {
        pendingInterviews: [{ blockId: "ask-1", requestedAt: 10 }],
        interviewAnswerability: [{ blockId: "ask-1", ordinal: 0 }],
      };
      const snapshot = (): Parameters<
        ChatStreamCallbacks["onWindowedSnapshot"]
      >[0] =>
        withPendingQuestion(
          windowedSnapshot({
            epoch: 4,
            rowCount: 30,
            tailFromOrdinal: 29,
            tailMessages: [userMessage("m-29", 29)],
            accumulatedFileChangeCount: 0,
          }),
          question,
        );

      callbacks.onWindowedSnapshot(snapshot());
      // The tail is complete and nothing is visible, so this request exists
      // only because ordinal 0 is required.
      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]?.fromOrdinal).toBe(0);

      callbacks.onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0"],
          messages: [oversizedMessage("m-0", 0)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: false,
        },
      });
      // Survived `onRange`'s eviction, and nothing was asked for again.
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.map((span) => span.fromOrdinal),
      ).toContain(0);
      expect(harness.rangeRequests).toHaveLength(1);

      // And survives the next snapshot's, which reads the FRAME's pair
      // because the store has not been given this one yet.
      callbacks.onWindowedSnapshot(snapshot());
      expect(
        harness.handle.store
          .getState()
          .transcriptWindow.spans.map((span) => span.fromOrdinal),
      ).toContain(0);
      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("nudges the provider query for a failure outside the hydrated tail", () => {
    // The exact shape the scan cannot see: the tail holds one user row and no
    // assistant record at all, so a backwards scan over `state.messages`
    // answers "no failure" and the re-auth banner never mounts.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        withAuthFailure(
          windowedSnapshot({
            epoch: 4,
            rowCount: 30,
            tailFromOrdinal: 29,
            tailMessages: [userMessage("m-29", 29)],
            accumulatedFileChangeCount: 0,
          }),
          "turn-failed",
        ),
      );

      expect(
        harness.handle.store
          .getState()
          .messages.some((message) => message.role === "assistant"),
      ).toBe(false);
      expect(harness.providerAuthNudgeCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("nudges once per failure, not once per snapshot carrying it", () => {
    // Every aux-only re-broadcast - a queue change, an approval - re-sends the
    // whole snapshot with the same derived key. A nudge per frame would
    // refetch `providers.list` on every chat event for as long as the failure
    // is the latest turn.
    const harness = createWindowedHarness();
    try {
      const frame = withAuthFailure(
        windowedSnapshot({
          epoch: 4,
          rowCount: 30,
          tailFromOrdinal: 29,
          tailMessages: [userMessage("m-29", 29)],
          accumulatedFileChangeCount: 0,
        }),
        "turn-failed",
      );
      harness.callbacks().onWindowedSnapshot(frame);
      harness.callbacks().onWindowedSnapshot(frame);
      expect(harness.providerAuthNudgeCount()).toBe(1);

      // A LATER failure is a different key, and must nudge again: the user may
      // already have re-authed the first one.
      harness
        .callbacks()
        .onWindowedSnapshot(withAuthFailure(frame, "turn-failed-again"));
      expect(harness.providerAuthNudgeCount()).toBe(2);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not nudge when the host reports no failure", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 3,
          tailFromOrdinal: 1,
          tailMessages: [userMessage("m-1", 1), userMessage("m-2", 2)],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.providerAuthNudgeCount()).toBe(0);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("windowed snapshot whose tail arrived empty", () => {
  it("does NOT run the fold, and asks for the tail instead", () => {
    // The host's tail walks backwards under a hard ceiling with no
    // always-serve-one exception, so a chat whose last row is over that budget
    // ships zero rows. Running the fold here would let it conclude that a
    // pending send never landed.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 40,
          tailFromOrdinal: 40,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );

      const state = harness.handle.store.getState();
      // `snapshotLoaded` is set INSIDE the fold, so this is the observable
      // proof that no reconcile pass ran - not merely that its result looked
      // unchanged.
      expect(state.snapshotLoaded).toBe(false);
      expect(state.messages).toEqual([]);
      // The index landed even though the fold did not: the window is what the
      // tail request is framed against.
      expect(state.transcriptWindow.rowCount).toBe(40);

      expect(harness.rangeRequests).toHaveLength(1);
      const request = harness.rangeRequests[0];
      expect(request.epoch).toBe(4);
      // 39, not 40: the wire's `toOrdinal` is INCLUSIVE, and with `rowCount`
      // 40 the last row is ordinal 39. Asking for 40 asked for a row that does
      // not exist - which is what forwarding the planner's exclusive bound
      // unconverted did on every request.
      expect(request.toOrdinal).toBe(39);
      expect(request.fromOrdinal).toBeLessThan(39);
    } finally {
      harness.handle.dispose();
    }
  });

  it("runs the held fold as soon as the tail range lands", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 2,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.handle.store.getState().snapshotLoaded).toBe(false);

      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: true,
        },
      });

      const state = harness.handle.store.getState();
      expect(state.snapshotLoaded).toBe(true);
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-0",
        "m-1",
      ]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps holding when the range that lands does not reach the tail", () => {
    // A `maxBytes` truncation answers with a prefix of what was asked for. The
    // rule is about the TAIL being present, not about a response having
    // arrived - so a short answer must not release the fold.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 4,
          tailFromOrdinal: 4,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: false,
          truncatedAtOrdinal: 2,
        },
      });

      expect(harness.handle.store.getState().snapshotLoaded).toBe(false);
      // And it asked again for the part still missing rather than settling.
      expect(harness.rangeRequests.length).toBeGreaterThan(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("carries the previous epoch's rows as placed stale bodies while the new tail loads", () => {
    // A reconnect or reindex rebases the transcript into a new coordinate
    // space. The rows the reader is looking at almost always still exist in
    // the replacement space under the same row ids, so the fold carries their
    // spans as STALE display state instead of blanking the transcript for the
    // length of the resnapshot round trip - the completion "flash". What must
    // NOT happen is the original hazard this test was written for: those rows
    // being re-published as unplaced rows of a space they were never numbered
    // in. They stay ordinal-bound (their old ordinals, yielding to the
    // replacement skeleton), which `transcriptListRows` owns and its own
    // suite pins; here the store-level halves are pinned - retention for
    // display, and a fresh-epoch re-request either way.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("old-0", 1), userMessage("old-1", 2)],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(
        harness.handle.store
          .getState()
          .messages.map((message) => message.messageId),
      ).toEqual(["old-0", "old-1"]);
      // The skeleton stream adopts the positionally-seated tail's row ids, as
      // it does on every real session before a rebase can arrive - the carry
      // below preserves ROW IDENTITY, which unadopted empty-string ids cannot
      // express.
      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromOrdinal: 0,
          entries: [
            {
              rowId: "old-0",
              createdAt: 1,
              role: "user",
              byteLength: 10,
              bodyDigest: "d0",
            },
            {
              rowId: "old-1",
              createdAt: 2,
              role: "user",
              byteLength: 10,
              bodyDigest: "d1",
            },
          ],
          isFinal: true,
        },
      });

      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 40,
          tailFromOrdinal: 40,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );

      const state = harness.handle.store.getState();
      expect(state.transcriptWindow.epoch).toBe(5);
      // Proof this is the DEFERRAL path rather than the fold: the window has
      // no span covering the last row, so the store is waiting on a tail it
      // has just asked for. (`snapshotLoaded` says nothing here - it latched
      // true on the first snapshot and a deferral does not clear it.)
      expect(isTailHydrated(state.transcriptWindow)).toBe(false);
      expect(harness.rangeRequests.at(-1)?.epoch).toBe(5);
      // Epoch 4's bodies survive as display-only stale spans - no FRESH span
      // claims an ordinal of the new space, so nothing can seat a body under
      // a wrong row id.
      expect(state.transcriptWindow.spans).toEqual([]);
      expect(
        state.transcriptWindow.staleSpans.flatMap((span) => span.rowIds),
      ).toEqual(["old-0", "old-1"]);
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "old-0",
        "old-1",
      ]);
      expect(state.events).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("a deferred snapshot's auxiliary state", () => {
  /**
   * The wait-for-tail rule holds the whole frame, but only the TRANSCRIPT half
   * of the fold is what the tail gates. Every other frame keeps being applied
   * while the snapshot waits, and a range answer can ride the BULK lane and
   * land well after them - so replaying the frame's own queue, turn and pending
   * state at that point reinstates values those frames had already replaced.
   *
   * It reinstates them PERMANENTLY, because nothing re-sends them. An approval
   * the agent is still blocked on disappears from the panel.
   */
  function approvalRequested(
    approvalId: string,
  ): Parameters<ChatStreamCallbacks["onApprovalRequested"]>[0] {
    return {
      kind: "approvalRequested",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      approval: {
        approvalId,
        toolName: "Bash",
        description: "rm -rf /tmp/x",
        input: null,
        requestedAt: 12,
        kind: "tool",
        planId: null,
        actions: [],
      },
    };
  }

  it("keeps what later frames delivered while the tail was outstanding", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 2,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);

      harness.callbacks().onApprovalRequested(approvalRequested("appr-1"));
      harness.callbacks().onQueueChanged({
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        queue: { status: "paused", items: [] },
      });
      expect(
        harness.handle.store
          .getState()
          .pendingApprovals.map((approval) => approval.approvalId),
      ).toEqual(["appr-1"]);

      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: true,
        },
      });

      const state = harness.handle.store.getState();
      // The fold ran - the tail is in and the transcript is published.
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-0",
        "m-1",
      ]);
      // ...without rewinding the frames that landed while it waited.
      expect(
        state.pendingApprovals.map((approval) => approval.approvalId),
      ).toEqual(["appr-1"]);
      expect(state.queue.status).toBe("paused");
    } finally {
      harness.handle.dispose();
    }
  });

  it("merges the snapshot's own aux with the frames that followed it", () => {
    // The union, and the reason "just use whatever the store holds" is not the
    // fix either: a deferred snapshot is the newer authority for everything no
    // later frame replaced, so its approval has to survive beside the later
    // frame's queue.
    const harness = createWindowedHarness();
    try {
      const frame = windowedSnapshot({
        epoch: 4,
        rowCount: 2,
        tailFromOrdinal: 2,
        tailMessages: [],
        accumulatedFileChangeCount: 0,
      });
      harness.callbacks().onWindowedSnapshot({
        ...frame,
        snapshot: {
          ...frame.snapshot,
          pendingApprovals: [
            {
              approvalId: "appr-snapshot",
              toolName: "Bash",
              description: "ls",
              input: null,
              requestedAt: 5,
              kind: "tool",
              planId: null,
              actions: [],
            },
          ],
        },
      });
      harness.callbacks().onQueueChanged({
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        queue: { status: "paused", items: [] },
      });
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: true,
        },
      });

      const state = harness.handle.store.getState();
      expect(
        state.pendingApprovals.map((approval) => approval.approvalId),
      ).toEqual(["appr-snapshot"]);
      expect(state.queue.status).toBe("paused");
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("an unanswered range request", () => {
  it("is retried once its wait runs out", () => {
    // The in-flight slot is the dedup key: while it holds a request for a
    // range, every later plan for that range is suppressed as already-asked.
    // A `loadRange` or its response dropped on a stream that stays OPEN clears
    // nothing, so the gap stays placeholders until the viewport moves or the
    // connection is rebuilt - neither of which is guaranteed to happen.
    vi.useFakeTimers();
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 40,
          tailFromOrdinal: 40,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.rangeRequests).toHaveLength(1);
      const first = harness.rangeRequests[0];

      // Nothing answers. Re-planning on its own is suppressed by the slot,
      // which is the wedge - so the wait has to expire.
      vi.advanceTimersByTime(29_000);
      expect(harness.rangeRequests).toHaveLength(1);
      vi.advanceTimersByTime(2_000);

      expect(harness.rangeRequests).toHaveLength(2);
      const retry = harness.rangeRequests[1];
      // The same gap, asked again under a NEW id - so the abandoned request's
      // answer, if it ever arrives, is discarded rather than seated.
      expect(retry.fromOrdinal).toBe(first.fromOrdinal);
      expect(retry.toOrdinal).toBe(first.toOrdinal);
      expect(retry.epoch).toBe(first.epoch);
      expect(retry.requestId).not.toBe(first.requestId);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("is not retried once it has been answered", () => {
    // The timeout is armed per request id and released with the slot. A
    // response that seats its range must take the deadline with it, or every
    // answered request mints a duplicate one timeout later.
    vi.useFakeTimers();
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 2,
          tailMessages: [],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.rangeRequests).toHaveLength(1);

      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: true,
        },
      });
      expect(harness.handle.store.getState().snapshotLoaded).toBe(true);

      vi.advanceTimersByTime(120_000);

      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });
});

describe("index deltas", () => {
  it("asks for a resnapshot rather than a range when the index is declared void", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      const rangesBefore = harness.rangeRequests.length;

      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 2,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      });

      expect(harness.resnapshotCount()).toBe(1);
      // A range against a void index would seat bodies in a coordinate space
      // this client has already left.
      expect(harness.rangeRequests).toHaveLength(rangesBefore);
    } finally {
      harness.handle.dispose();
    }
  });

  it("asks again when the resnapshot it was waiting for never arrives", () => {
    // The same wedge an unanswered range request has, and worse: the latch
    // that keeps an invalidated window from asking once per frame is cleared
    // only by a snapshot, which is exactly what is missing. Every ordinal in a
    // void index belongs to a coordinate space this client has left, so
    // nothing on screen can be repaired until one lands.
    vi.useFakeTimers();
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 2,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      });
      expect(harness.resnapshotCount()).toBe(1);

      // Nothing answers, and no further frame arrives to re-drive the plan.
      vi.advanceTimersByTime(31_000);

      expect(harness.resnapshotCount()).toBe(2);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("stops asking once the snapshot lands", () => {
    // The latch and its deadline are released together, so an answered
    // resnapshot does not mint a duplicate one timeout later.
    vi.useFakeTimers();
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 2,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      });
      expect(harness.resnapshotCount()).toBe(1);

      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      // The skeleton the host streams behind every snapshot. Delivered here
      // because the completion watchdog reads what the snapshot PROMISED
      // rather than whether a chunk was seen: a fixture that stops at the
      // snapshot is not a short healthy chat, it is a chat whose only skeleton
      // chunk was dropped, and the watchdog is right to restream that.
      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 5,
          fromOrdinal: 0,
          entries: [
            {
              rowId: "row-0",
              createdAt: 1,
              role: "user",
              byteLength: 10,
              bodyDigest: "d0",
            },
            {
              rowId: "row-1",
              createdAt: 2,
              role: "user",
              byteLength: 10,
              bodyDigest: "d1",
            },
          ],
          isFinal: true,
        },
      });
      vi.advanceTimersByTime(120_000);

      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  /**
   * The watchdog measures "has anything arrived lately", so only something that
   * actually carries stream content may restart its clock.
   *
   * An aux-only re-broadcast carries none - it is the same snapshot re-sent
   * against an unchanged skeleton for a queue change or an approval - and an
   * active chat produces them constantly. Restarting the deadline on each one
   * postpones stall detection for as long as the chat stays busy, which is
   * exactly when a dropped chunk is most likely and least affordable: the
   * transcript keeps its missing rows for the rest of the connection because
   * nothing ever asks again.
   *
   * The fixture is deliberately arithmetic: two aux snapshots inside one
   * deadline, and a total elapsed time well past it. If aux traffic restarts
   * the clock, the watchdog never fires.
   */
  it("does not let aux-only snapshots postpone the stall watchdog", () => {
    vi.useFakeTimers();
    const harness = createWindowedHarness();
    try {
      // A rebuild snapshot promising two rows. Its skeleton chunk never
      // arrives, so delivery is incomplete from here on.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.resnapshotCount()).toBe(0);

      const auxFrame = windowedSnapshot({
        epoch: 4,
        rowCount: 2,
        tailFromOrdinal: 0,
        tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
        accumulatedFileChangeCount: 0,
      });
      const sendAux = (): void => {
        harness.callbacks().onWindowedSnapshot({
          ...auxFrame,
          // A HELD revision - the host has this client's index and is
          // re-broadcasting aux state, not rebuilding.
          snapshot: { ...auxFrame.snapshot, indexRevision: 0 },
        });
      };

      // Two aux re-broadcasts, each comfortably inside the deadline.
      vi.advanceTimersByTime(20_000);
      sendAux();
      vi.advanceTimersByTime(20_000);
      sendAux();
      // 40s elapsed, still under the 45s deadline: nothing should have fired
      // yet either, or the test would pass for the wrong reason.
      expect(harness.resnapshotCount()).toBe(0);

      vi.advanceTimersByTime(10_000);

      // 50s since the stream went quiet. The stall is real and reported.
      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  /**
   * The resnapshot entry's dedup is keyed on the THREE boundary cases (a
   * rebuild announcement, a rebase, a voided index), never on "a snapshot
   * arrived" - an aux-only re-broadcast (a queue change, an approval) rides
   * the same `onWindowedSnapshot` handler at a HELD revision and must leave
   * the entry standing, or a steady drip of aux traffic would close it once
   * per frame while the real answer is still in flight and re-send a
   * resnapshot for every approval.
   */
  it("survives an aux-only re-broadcast while void, but a later void reopens it", () => {
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 2,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      });
      expect(harness.resnapshotCount()).toBe(1);

      // An aux-only re-broadcast at the SAME epoch, with a concrete revision
      // and no rebuild announcement - none of the three boundary cases. The
      // pending resnapshot entry is what asked for the repair; closing it
      // here is the shape that looks conservative and destroys the answer -
      // the entry's dedup would release, and a re-plan could mint a second
      // request for a repair already travelling on the wire.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
          indexRevision: 1,
        }),
      );
      // No second resnapshot: the entry survived the aux frame.
      expect(harness.resnapshotCount()).toBe(1);

      // The rebuild-announcing snapshot IS a boundary case - `indexRevision:
      // null` - and closes the entry.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 2,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0), userMessage("m-1", 1)],
          accumulatedFileChangeCount: 0,
        }),
      );
      expect(harness.resnapshotCount()).toBe(1);

      // A LATER void can now reopen the entry and ask again - proof the close
      // above actually happened rather than merely reading as inert.
      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 6,
        rowCount: 2,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      });
      expect(harness.resnapshotCount()).toBe(2);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * The store-level half of {@link isActiveTurnStreamingEcho}: an `indexChanged`
 * naming only the active turn's own row must not treat an in-flight hydration
 * request as stale, or a chat dominated by one long-running turn starves every
 * scrollback fetch for as long as the turn streams.
 */
describe("the active turn's streaming echo does not starve in-flight hydration", () => {
  type IndexChangedFrame = Parameters<ChatStreamCallbacks["onIndexChanged"]>[0];

  function indexChangedFrame(input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
    readonly changes: IndexChangedFrame["changes"];
  }): IndexChangedFrame {
    return {
      kind: "indexChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      epoch: input.epoch,
      rowCount: input.rowCount,
      indexRevision: input.indexRevision,
      changes: [...input.changes],
    };
  }

  type RangeFrame = Parameters<ChatStreamCallbacks["onRange"]>[0];

  function rangeFrame(input: {
    readonly requestId: string;
    readonly epoch: number;
    readonly fromOrdinal: number;
    readonly rowIds: readonly string[];
    readonly messages: readonly Message[];
  }): RangeFrame {
    return {
      kind: "range",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      range: {
        requestId: input.requestId,
        epoch: input.epoch,
        fromOrdinal: input.fromOrdinal,
        rowIds: [...input.rowIds],
        messages: [...input.messages],
        events: [],
        rowContext: {},
        reachedStart: input.fromOrdinal === 0,
        reachedEnd: false,
      },
    };
  }

  function seatedTail(harness: WindowedHarness): void {
    harness.callbacks().onWindowedSnapshot(
      windowedSnapshot({
        epoch: 1,
        rowCount: 40,
        tailFromOrdinal: 20,
        tailMessages: [userMessage("tail", 20)],
        accumulatedFileChangeCount: 0,
      }),
    );
  }

  /** A tail whose span HOLDS the active turn's streaming assistant message. */
  function seatedTailHoldingTurn(
    harness: WindowedHarness,
    turnId: string,
  ): void {
    harness.callbacks().onWindowedSnapshot(
      windowedSnapshot({
        epoch: 1,
        rowCount: 40,
        tailFromOrdinal: 20,
        tailMessages: [
          userMessage("tail", 20),
          assistantWithBlocks("assistant-live", 21, turnId, []),
        ],
        accumulatedFileChangeCount: 0,
      }),
    );
  }

  it("a streaming echo does not supersede in-flight hydration", () => {
    const harness = createWindowedHarness();
    try {
      // The tail span holds the streaming turn's record - the ordinary state
      // mid-turn, and the precondition for the echo exemption: only a HELD
      // copy is being rewritten in place by the delta stream.
      seatedTailHoldingTurn(harness, "t-9");
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestId = harness.lastRangeRequestId();

      // The index's own echo of the turn already streaming: the deltas that
      // produced it rewrote the held records in place, so there is nothing
      // stale about an answer still in flight for this row.
      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 10,
                  entry: {
                    rowId: assistantRowId("t-9"),
                    createdAt: 10,
                    role: "assistant",
                    byteLength: 4096,
                    bodyDigest: "d10-echo",
                  },
                },
              ],
            },
          ],
        }),
      );

      harness.callbacks().onRange(
        rangeFrame({
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [assistantWithBlocks("assistant-10", 10, "t-9", [])],
        }),
      );

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a frame naming a DIFFERENT turn's row still supersedes, and the discarded answer is re-planned", () => {
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestId = harness.lastRangeRequestId();
      expect(harness.rangeRequests).toHaveLength(1);

      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 10,
                  entry: {
                    rowId: assistantRowId("other-turn"),
                    createdAt: 10,
                    role: "assistant",
                    byteLength: 4096,
                    bodyDigest: "d10-other",
                  },
                },
              ],
            },
          ],
        }),
      );

      harness.callbacks().onRange(
        rangeFrame({
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("other-turn")],
          messages: [assistantWithBlocks("assistant-10", 10, "other-turn", [])],
        }),
      );

      // Discarded: the pre-update body must not seat.
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(false);
      // And re-planned, because ordinal 10 is still a gap.
      expect(harness.rangeRequests.length).toBeGreaterThan(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not supersede in-flight hydration for a frame the window REJECTS", () => {
    // `supersedeInFlightHydration` ran before `applyIndexChange` had judged the
    // frame. A duplicated or reordered same-epoch straggler is dropped on
    // `indexRevision <= window.indexRevision` and changes nothing - but the
    // ledger had already marked the in-flight request, so its valid answer was
    // discarded and re-asked, extending exactly the placeholders it would have
    // filled. Repeated stragglers can keep a range from settling at all.
    const harness = createWindowedHarness();
    try {
      // A concrete revision, so `indexRevisionRebuilding` is disarmed and the
      // revision checks actually apply - the default `null` suspends them.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 1,
          rowCount: 40,
          tailFromOrdinal: 20,
          tailMessages: [userMessage("tail", 20)],
          accumulatedFileChangeCount: 0,
          indexRevision: 5,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestId = harness.lastRangeRequestId();

      // Names a DIFFERENT turn, so the streaming-echo exemption cannot be what
      // saves the request - only the rejection can.
      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 5,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 10,
                  entry: {
                    rowId: assistantRowId("other-turn"),
                    createdAt: 10,
                    role: "assistant",
                    byteLength: 4096,
                    bodyDigest: "d10-straggler",
                  },
                },
              ],
            },
          ],
        }),
      );

      harness.callbacks().onRange(
        rangeFrame({
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("other-turn")],
          messages: [assistantWithBlocks("assistant-10", 10, "other-turn", [])],
        }),
      );

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  /** A text block, so an answer's body is distinguishable from its successor's. */
  function textBlock(blockId: string, text: string): AssistantBlocks[number] {
    return {
      type: "text",
      blockId,
      status: "streaming",
      timestamp: 1,
      text,
      providerNotice: null,
    };
  }

  /**
   * The streaming turn's body as of some point in the turn, carrying the host's
   * write counter for that slice.
   *
   * The counter is what a settled record's substitution rules read, and it is
   * the ordinary shape the host serves - so these bodies exercise the versioned
   * path. It is NOT what decides whether a catch-up is owed: that is the
   * request's own write mark, which is why the versionless bodies below recover
   * their content just the same. See `versionlessTurnBody`.
   */
  function turnBodyAt(text: string, blocksVersion: number): Message {
    const base = assistantWithBlocks("assistant-10", 10, "t-9", [
      textBlock("b-1", text),
    ]);
    return base.role === "assistant" ? { ...base, blocksVersion } : base;
  }

  /**
   * The streaming turn's body with NO `blocksVersion`, which the wire schema
   * still allows and delta writers preserve.
   */
  function versionlessTurnBody(text: string): Message {
    return assistantWithBlocks("assistant-10", 10, "t-9", [
      textBlock("b-1", text),
    ]);
  }

  /** One `text.delta` from the host, appended to the turn's text block. */
  function streamTextDelta(harness: WindowedHarness, delta: string): void {
    harness.callbacks().onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: { type: "text.delta", blockId: "b-1", timestamp: 5, delta },
    });
  }

  /** The text the store is currently publishing for the streaming turn. */
  function publishedTurnText(harness: WindowedHarness): string | undefined {
    const message = harness.handle.store
      .getState()
      .messages.find((candidate) => candidate.messageId === "assistant-10");
    const block = blockOf(message, "b-1");
    return block?.type === "text" ? block.text : undefined;
  }

  /**
   * A skeleton whose ordinals 10-12 are ONE steered turn - two assistant slices
   * with the steer bubble between them - so an echo can name one slice while a
   * request is in flight for the other.
   */
  function splitTurnSkeleton(): Parameters<
    ChatStreamCallbacks["onSkeletonChunk"]
  >[0] {
    const rowIds = new Map([
      [10, assistantSliceRowId("t-9", 0, true)],
      [11, "steer:q-9"],
      [12, assistantSliceRowId("t-9", 1, true)],
    ]);
    return {
      kind: "skeletonChunk",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      chunk: {
        epoch: 1,
        fromOrdinal: 0,
        entries: Array.from({ length: 40 }, (_unused, ordinal) => ({
          rowId: rowIds.get(ordinal) ?? `row-${ordinal}`,
          createdAt: ordinal,
          role: "user" as const,
          byteLength: 64,
          bodyDigest: `d${ordinal}`,
        })),
        isFinal: true,
      },
    };
  }

  /** One per-approval `updated` echo of the streaming row, at `revision`. */
  function streamingRowEcho(revision: number): IndexChangedFrame {
    return indexChangedFrame({
      epoch: 1,
      rowCount: 40,
      indexRevision: revision,
      changes: [
        {
          type: "updated",
          entries: [
            {
              ordinal: 10,
              entry: {
                rowId: assistantRowId("t-9"),
                createdAt: 10,
                role: "assistant",
                byteLength: 4096 * revision,
                bodyDigest: `d10-approval-${revision}`,
              },
            },
          ],
        },
      ],
    });
  }

  it("a storm of streaming echoes against an UNHELD turn seats the row, catches it up, and then leaves it alone", () => {
    // The loop that left a tool-heavy turn's own row as a placeholder for the
    // life of the turn. The window holds no copy of the streaming turn (the
    // tail below does not carry it), the viewport asks for its row, and the
    // host echoes the row's index entry once per approval while the answer is
    // in flight. Before the fix each echo superseded the request, the answer
    // was discarded, the re-plan asked again and the next echo caught that
    // one too.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      expect(harness.rangeRequests).toHaveLength(1);

      // Five approvals land while the first answer is on the wire. None of
      // them may supersede it, and none may mint a request of its own.
      for (let revision = 1; revision <= 5; revision += 1) {
        harness.callbacks().onIndexChanged(streamingRowEcho(revision));
      }
      expect(harness.rangeRequests).toHaveLength(1);

      // The body the host sliced BEFORE those five writes - what a pre-echo
      // answer necessarily carries.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before the approvals", 1)],
        }),
      );

      // The answer SEATED - it was not discarded - so the row draws instead of
      // going back to a placeholder. But it predates writes this client
      // dropped, so its span is retired to the stale tier (still rendering the
      // body it carried) and exactly one catch-up request goes out.
      const afterFirst = harness.handle.store.getState().transcriptWindow;
      expect(afterFirst.spans.some((span) => span.fromOrdinal === 10)).toBe(
        false,
      );
      expect(
        afterFirst.staleSpans.some((span) => span.fromOrdinal === 10),
      ).toBe(true);
      expect(publishedTurnText(harness)).toBe("before the approvals");
      expect(harness.rangeRequests).toHaveLength(2);
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(catchUpRequestId).not.toBe(firstRequestId);
      expect(harness.rangeRequests[1]?.fromOrdinal).toBe(10);

      // More approvals while the CATCH-UP is in flight. The host may well have
      // sliced after them - the client cannot tell - so this is not "the answer
      // is missing them", it is "the answer has not ESTABLISHED that it covers
      // them". A body seated around a gap goes on missing the write whatever
      // lands on it afterwards, so the conservative reading is the only safe
      // one: seat it, and ask once more across a quiet interval.
      for (let revision = 6; revision <= 8; revision += 1) {
        harness.callbacks().onIndexChanged(streamingRowEcho(revision));
      }
      expect(harness.rangeRequests).toHaveLength(2);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("after the approvals", 2)],
        }),
      );
      expect(publishedTurnText(harness)).toBe("after the approvals");
      expect(harness.rangeRequests).toHaveLength(3);
      const finalRequestId = harness.lastRangeRequestId();

      // This one is asked and answered across a quiet stream: no write happened
      // between it going out and coming back, so it carries every write up to
      // its slice and the client has applied every write since. That is the
      // whole of the turn, and it is what ends the obligation.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: finalRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("all of the approvals", 3)],
        }),
      );

      // Final: a further storm of echoes neither retires it nor asks again.
      const afterCatchUp = harness.handle.store.getState().transcriptWindow;
      expect(afterCatchUp.spans.some((span) => span.fromOrdinal === 10)).toBe(
        true,
      );
      expect(publishedTurnText(harness)).toBe("all of the approvals");
      for (let revision = 9; revision <= 14; revision += 1) {
        harness.callbacks().onIndexChanged(streamingRowEcho(revision));
      }
      const settled = harness.handle.store.getState().transcriptWindow;
      expect(settled.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
      expect(publishedTurnText(harness)).toBe("all of the approvals");
      expect(harness.rangeRequests).toHaveLength(3);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a second pre-echo answer cannot discharge the catch-up the first one owed", () => {
    // The dedup slot hides the catch-up when several requests for the same
    // range are outstanding. A is sent, the viewport moves away and back so B
    // and C follow, then the echo lands. A seats and asks for a catch-up - but
    // C already names that range, so the planner suppresses it. C's answer is
    // just as old as A's, and an obligation keyed on the ordinal would read as
    // discharged the moment A consumed it, leaving the pre-echo body on screen
    // with nothing outstanding. The mark is on the REQUEST, so C owes the
    // catch-up too, and the request that finally settles the row is one sent
    // after the dropped write.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");
      const store = harness.handle.store.getState();

      store.reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestA = harness.lastRangeRequestId();
      store.reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 13 });
      store.reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestC = harness.lastRangeRequestId();
      expect(harness.rangeRequests).toHaveLength(3);
      expect(requestC).not.toBe(requestA);

      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: requestA,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("A: before the write", 1)],
        }),
      );
      // A's catch-up is suppressed by C's dedup slot - the state the ordinal
      // debt could not see.
      expect(harness.rangeRequests).toHaveLength(3);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: requestC,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("C: also before the write", 1)],
        }),
      );

      // C is pre-echo too, so it owes the same catch-up - and its own arrival
      // freed the slot, so this one is actually sent.
      expect(harness.rangeRequests).toHaveLength(4);
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(harness.rangeRequests[3]?.fromOrdinal).toBe(10);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("after the write", 2)],
        }),
      );

      expect(publishedTurnText(harness)).toBe("after the write");
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
      expect(harness.rangeRequests).toHaveLength(4);
    } finally {
      harness.handle.dispose();
    }
  });

  it("an echo naming a SIBLING slice still catches up the answer carrying the turn's records", () => {
    // A turn's records are shared by every row it produces, so an answer for
    // slice 0 carries exactly the record slice 1 renders from. An echo naming
    // only slice 1 therefore stales a body being served under an ordinal it
    // never mentioned - which an obligation keyed on the echoed ordinal misses
    // entirely, because ordinal 12 is neither visible nor requested.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      harness.callbacks().onSkeletonChunk(splitTurnSkeleton());
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const sliceRequestId = harness.lastRangeRequestId();
      expect(harness.rangeRequests).toHaveLength(1);

      // Echoes the OTHER slice of the same turn.
      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 12,
                  entry: {
                    rowId: assistantSliceRowId("t-9", 1, true),
                    createdAt: 12,
                    role: "assistant",
                    byteLength: 8192,
                    bodyDigest: "d12-echo",
                  },
                },
              ],
            },
          ],
        }),
      );

      harness.callbacks().onRange(
        rangeFrame({
          requestId: sliceRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantSliceRowId("t-9", 0, true)],
          messages: [turnBodyAt("slice body before the sibling write", 1)],
        }),
      );

      // The catch-up is owed by the ANSWER, which carried the turn's records,
      // not by the ordinal the echo happened to name.
      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]?.fromOrdinal).toBe(10);
    } finally {
      harness.handle.dispose();
    }
  });

  it("an answer that seats no body leaves the catch-up owed for the row's next answer", () => {
    // A row can come back listed in `incompleteRowIds`: the host served the row
    // id but withheld its records, so nothing seats. Spending the obligation
    // there retires it against a body that never arrived, and the row's real
    // answer - which can be just as old - then seats permanently. Nothing is
    // consumed here, so the next answer is judged on its own provenance.
    const info = vi.spyOn(appLogger, "info").mockImplementation(() => {});
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      const incomplete = rangeFrame({
        requestId: firstRequestId,
        epoch: 1,
        fromOrdinal: 10,
        rowIds: [assistantRowId("t-9")],
        messages: [turnBodyAt("withheld", 1)],
      });
      harness.callbacks().onRange({
        ...incomplete,
        range: {
          ...incomplete.range,
          incompleteRowIds: [assistantRowId("t-9")],
        },
      });

      // Nothing seated, so nothing is retired and no catch-up is claimed.
      const afterIncomplete = harness.handle.store.getState().transcriptWindow;
      expect(
        afterIncomplete.spans.some((span) => span.fromOrdinal === 10),
      ).toBe(false);
      expect(
        afterIncomplete.staleSpans.some((span) => span.fromOrdinal === 10),
      ).toBe(false);
      // And the log says so. A re-ask logged against an answer that seated
      // nothing reads, to whoever is debugging this next, as a body corrected
      // when none was ever drawn.
      expect(info).not.toHaveBeenCalledWith(
        expect.stringContaining("predates a dropped write"),
        expect.anything(),
      );

      // The row becomes servable again and is re-requested.
      harness.callbacks().onIndexChanged(streamingRowEcho(2));
      const retryRequestId = harness.lastRangeRequestId();
      expect(retryRequestId).not.toBe(firstRequestId);

      // A further echo WHILE that retry is in flight, with the turn still
      // unheld - the interleaving the whole mark exists for. An obligation
      // keyed on the echoed ordinal was already spent by the answer that seated
      // nothing, so the retry's own staleness went unnoticed and its body
      // seated for good.
      harness.callbacks().onIndexChanged(streamingRowEcho(3));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: retryRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("stale", 2)],
        }),
      );

      // Sliced before that second echo, so it seats provisionally and is asked
      // for again rather than standing as the turn's body.
      const thirdRequestId = harness.lastRangeRequestId();
      expect(thirdRequestId).not.toBe(retryRequestId);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: thirdRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("current", 3)],
        }),
      );

      expect(publishedTurnText(harness)).toBe("current");
      const settled = harness.handle.store.getState().transcriptWindow;
      expect(settled.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      info.mockRestore();
      harness.handle.dispose();
    }
  });

  it("a pre-echo answer carrying no record of the streaming turn is left alone", () => {
    // The bound on the catch-up. A dropped write stales the turn it was written
    // for and nothing else, so scrollback fetched in the same window is current
    // - re-asking for it would spend a round trip per echo on rows the write
    // could not have touched.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 4, toOrdinal: 5 });
      const scrollbackRequestId = harness.lastRangeRequestId();
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: scrollbackRequestId,
          epoch: 1,
          fromOrdinal: 4,
          rowIds: ["row-4"],
          messages: [userMessage("m-4", 4)],
        }),
      );

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 4)).toBe(true);
      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("recovers a write that a delta overtook the catch-up answer for", () => {
    // The provisionally seated body is TORN, and that is the whole difficulty.
    // The catch-up carries the write the client dropped; the deltas that landed
    // on the provisional body while the catch-up flew carry writes the catch-up
    // predates. Neither copy is a superset of the other, so a rule that just
    // picks one loses text either way - the answer is to notice that the seat
    // was overtaken and ask once more, for a slice taken after both writes.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();

      // Dropped: nothing holds the turn, so this write has nowhere to land.
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // Sliced before that write, so it seats provisionally and owes a catch-up.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before", 1)],
        }),
      );
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(catchUpRequestId).not.toBe(firstRequestId);

      // This one is NOT dropped - the provisional body absorbs it - but it
      // overtakes the catch-up already in flight, so the answer coming back
      // cannot contain it.
      streamTextDelta(harness, " later");
      expect(publishedTurnText(harness)).toBe("before later");
      harness.callbacks().onIndexChanged(streamingRowEcho(2));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );

      // Equal versions, and the client's counter is its own: it counts the
      // writes this client applied, from a base already behind the host, so a
      // tie proves nothing. Certifying the answer here on its request's mark
      // published `before later` and left ` missed` gone for the turn.
      const secondCatchUpId = harness.lastRangeRequestId();
      expect(secondCatchUpId).not.toBe(catchUpRequestId);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: secondCatchUpId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed later", 3)],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed later");
      // Settled: a slice nothing overtook seats fresh and is asked for no more.
      const settled = harness.handle.store.getState().transcriptWindow;
      expect(settled.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
      expect(harness.lastRangeRequestId()).toBe(secondCatchUpId);
    } finally {
      harness.handle.dispose();
    }
  });

  it("seats a catch-up over a provisional body that carries no version", () => {
    // `blocksVersion` is optional on the wire and delta writers preserve its
    // absence, so the catch-up and the body it repairs can both arrive without
    // one. The held-copy preference cannot prove the provisional body older and
    // used to keep it - pinning the incomplete text with no gap left to
    // re-request. A body the client itself flagged as short of the host has no
    // claim on the stream's authority, so the serve seats.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();

      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before")],
        }),
      );
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(catchUpRequestId).not.toBe(firstRequestId);

      // Nothing overtakes this one, so it is the whole truth as of its slice.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before missed")],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed");
      // And it is final: an install discharges the obligation, so no third
      // request goes out.
      expect(harness.lastRangeRequestId()).toBe(catchUpRequestId);
      const settled = harness.handle.store.getState().transcriptWindow;
      expect(settled.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("leaves a COMPLETE row alone when the same answer withholds the streaming turn", () => {
    // A mixed answer: one settled row served whole, the active turn's row listed
    // incomplete. The fold withholds the whole turn's records, so nothing of it
    // seats - but the raw answer still carries them, and reading the raw records
    // retired every ordinal the answer served. That threw away the settled row's
    // valid hydration and re-asked for it, to chase a body the fold had already
    // refused. What seats is what decides.
    const info = vi.spyOn(appLogger, "info").mockImplementation(() => {});
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 9, toOrdinal: 11 });
      const requestId = harness.lastRangeRequestId();
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      const mixed = rangeFrame({
        requestId,
        epoch: 1,
        fromOrdinal: 9,
        rowIds: [assistantRowId("t-8"), assistantRowId("t-9")],
        messages: [
          assistantWithBlocks("assistant-9", 9, "t-8", [
            textBlock("b-8", "settled"),
          ]),
          turnBodyAt("withheld", 1),
        ],
      });
      harness.callbacks().onRange({
        ...mixed,
        range: { ...mixed.range, incompleteRowIds: [assistantRowId("t-9")] },
      });

      // The settled row seated and stays FRESH: no catch-up was owed for it,
      // and none of the streaming turn seated to owe one.
      const seated = harness.handle.store.getState().transcriptWindow;
      expect(seated.spans.some((span) => span.fromOrdinal === 9)).toBe(true);
      expect(seated.staleSpans.some((span) => span.fromOrdinal === 9)).toBe(
        false,
      );
      // And nothing claims a catch-up it did not perform.
      expect(info).not.toHaveBeenCalledWith(
        expect.stringContaining("predates a dropped write"),
        expect.anything(),
      );
      // Nothing is re-requested at all. The withheld row is marked unavailable,
      // which the planner skips, and the settled row is hydrated - so the
      // correct amount of traffic here is none. Retiring the served ordinals
      // asked for the settled row again, wire-inclusive [9,9], purely to
      // re-fetch a body that had not changed.
      expect(harness.lastRangeRequestId()).toBe(requestId);
    } finally {
      info.mockRestore();
      harness.handle.dispose();
    }
  });

  it("stops asking once the stream has overtaken every catch-up", () => {
    // The bound. Each catch-up is answered with a slice the next delta
    // immediately overtakes, which is a live possibility on a fast turn. Asking
    // again is right up to a point; a request per round trip for the length of
    // the turn is not, so the client keeps what it has and lets the completion
    // rebase - which re-seats the turn from the host - finish the repair.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      let requestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      const requestIds = new Set<string>([requestId]);
      for (let round = 1; round <= 8; round += 1) {
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [turnBodyAt(`slice-${round}`, round)],
          }),
        );
        const next = harness.lastRangeRequestId();
        if (next === requestId) break;
        requestId = next;
        requestIds.add(next);
        // Every catch-up is overtaken the moment it is asked for.
        streamTextDelta(harness, `-${round}`);
        harness.callbacks().onIndexChanged(streamingRowEcho(round + 1));
      }

      // The first request plus MAX_PROVISIONAL_CATCH_UP_ROUNDS catch-ups, and
      // then it stops - not one per delta for the rest of the turn.
      expect(requestIds.size).toBe(MAX_PROVISIONAL_CATCH_UP_ROUNDS + 1);
      const settled = harness.handle.store.getState().transcriptWindow;
      expect(settled.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("charges the repair budget for catch-ups SENT, not for demotions the dedup slot suppresses", () => {
    // Several requests can be outstanding for the same row at once - ordinary
    // scrolling does it - and every one of their answers predates the write. The
    // first demotion asks for a re-plan and gets nothing, because the dedup slot
    // still names a request covering those rows; so do the second and third.
    // Charging the budget at the demotion spent all three rounds on suppressed
    // re-plans and then announced that the client was giving up, having asked
    // the host exactly nothing. The budget is for requests that reach the wire.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      // Seven outstanding requests, under the ledger's cap of eight; four of
      // them for row 10, and the last one owns the dedup slot.
      const rowTenRequestIds: string[] = [];
      for (const ordinal of [10, 12, 10, 13, 10, 14, 10]) {
        harness.handle.store.getState().reportVisibleTranscriptRange({
          fromOrdinal: ordinal,
          toOrdinal: ordinal + 1,
        });
        if (ordinal === 10) rowTenRequestIds.push(harness.lastRangeRequestId());
      }
      expect(harness.rangeRequests).toHaveLength(7);
      expect(rowTenRequestIds).toHaveLength(4);

      // One write, dropped while the turn is unheld. The stream then goes
      // quiet, so a single corrective request would be answered with the truth.
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // All four row-10 answers were sliced before that write. Oldest first.
      for (const requestId of rowTenRequestIds) {
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [turnBodyAt("before", 1)],
          }),
        );
      }

      // Exactly one of those four demotions could actually send, and it did.
      expect(harness.rangeRequests).toHaveLength(8);
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(rowTenRequestIds).not.toContain(catchUpRequestId);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed");
    } finally {
      harness.handle.dispose();
    }
  });

  it("one answer installing a body does not discharge what another still owes", () => {
    // Two answers for the same row are in flight, both sliced before a write
    // that overtakes them. The first installs its body; a rule that asked "has
    // the held body changed since the last seat" then read the second answer as
    // current, because the first had just reset that baseline - and discharged
    // the obligation with the write still missing. Each request carries its own
    // mark, so what one answer does to the body cannot answer for another.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before", 1)],
        }),
      );
      const b = harness.lastRangeRequestId();

      // Scroll away and back: a second request for the same row, which takes
      // the dedup slot and will suppress the re-plan B's own answer asks for.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 13 });
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const d = harness.lastRangeRequestId();
      expect(d).not.toBe(b);

      // A write overtakes both of them.
      streamTextDelta(harness, " later");
      harness.callbacks().onIndexChanged(streamingRowEcho(2));

      const sentBefore = harness.rangeRequests.length;
      harness.callbacks().onRange(
        rangeFrame({
          requestId: b,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );
      // B's demotion is suppressed by D's outstanding request, so nothing is
      // sent and nothing is charged.
      expect(harness.rangeRequests).toHaveLength(sentBefore);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: d,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );
      // D predates ` later` just as B did, so it owes the repair it cannot make.
      const repairId = harness.lastRangeRequestId();
      expect(repairId).not.toBe(d);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: repairId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed later", 3)],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed later");
    } finally {
      harness.handle.dispose();
    }
  });

  it("recovers an overtaking write when NO body carries a version", () => {
    // The two supported shapes at once: the host omits `blocksVersion`, and a
    // write overtakes the catch-up. A change detector reading that optional
    // field saw every copy as version zero, so the overtaking write was
    // invisible and the already-rendered text was overwritten and forgotten.
    // The request's own mark needs no field on the record.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before")],
        }),
      );
      const catchUpRequestId = harness.lastRangeRequestId();

      streamTextDelta(harness, " later");
      expect(publishedTurnText(harness)).toBe("before later");
      harness.callbacks().onIndexChanged(streamingRowEcho(2));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before missed")],
        }),
      );
      const secondCatchUpId = harness.lastRangeRequestId();
      expect(secondCatchUpId).not.toBe(catchUpRequestId);

      harness.callbacks().onRange(
        rangeFrame({
          requestId: secondCatchUpId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before missed later")],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed later");
    } finally {
      harness.handle.dispose();
    }
  });

  it("a late answer from the exhausted episode does not restart the budget", () => {
    // The cap has to be a per-turn total, so the record of having spent it
    // outlives the episode. Forgetting it at the cap let an answer that had been
    // in flight the whole time arrive afterwards, find a fresh budget, and start
    // the rounds over - with no new write, eviction, boundary or turn change to
    // justify it.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const stragglerId = harness.lastRangeRequestId();
      // A second request for the same row, which is the one the episode below
      // runs on; the first is left in flight throughout.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 13 });
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      let requestId = harness.lastRangeRequestId();

      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // Burn the budget: every catch-up is overtaken as soon as it is sent.
      for (let round = 1; round <= 6; round += 1) {
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [turnBodyAt(`slice-${round}`, round)],
          }),
        );
        const next = harness.lastRangeRequestId();
        if (next === requestId) break;
        requestId = next;
        streamTextDelta(harness, `-${round}`);
        harness.callbacks().onIndexChanged(streamingRowEcho(round + 1));
      }
      const exhausted = harness.rangeRequests.length;

      // The straggler: still eligible, still older than the write, arriving
      // after the client already gave up.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: stragglerId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("straggler", 1)],
        }),
      );

      expect(harness.rangeRequests).toHaveLength(exhausted);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a NEW turn gets its own repair budget", () => {
    // The exhaustion is the previous turn's, and it must not be charged to the
    // next one. `turnId` guarded which body the obligation was about but not the
    // rounds beside it, so a turn raised before any authority movement inherited
    // an exhausted budget and gave up before asking even once.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      let requestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // Spend the whole budget WITHOUT tripping the cap: three catch-ups are
      // sent, each overtaken as soon as it goes out, and the third is left
      // outstanding. That leaves the previous turn's record at its limit and
      // still live, which is the state the next turn must not inherit.
      for (
        let round = 1;
        round <= MAX_PROVISIONAL_CATCH_UP_ROUNDS;
        round += 1
      ) {
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [turnBodyAt(`slice-${round}`, round)],
          }),
        );
        const next = harness.lastRangeRequestId();
        expect(next).not.toBe(requestId);
        requestId = next;
        streamTextDelta(harness, `-${round}`);
        harness.callbacks().onIndexChanged(streamingRowEcho(round + 1));
      }
      const afterExhaustion = harness.rangeRequests.length;

      // The turn completes and the next one starts, with no authority boundary
      // between them - so nothing has re-seated the window and the spent budget
      // is still the only record of the previous episode.
      completeActiveTurn(harness.callbacks());
      raiseActiveTurn(harness.callbacks(), "t-10");
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 13 });
      const nextTurnRequestId = harness.lastRangeRequestId();
      // The write reaches the client only as an index echo, with nothing of the
      // new turn held - so it is dropped, exactly as the first turn's was.
      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 5,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 12,
                  entry: {
                    rowId: assistantRowId("t-10"),
                    createdAt: 12,
                    role: "assistant",
                    byteLength: 4096,
                    bodyDigest: "d12-echo",
                  },
                },
              ],
            },
          ],
        }),
      );

      harness.callbacks().onRange(
        rangeFrame({
          requestId: nextTurnRequestId,
          epoch: 1,
          fromOrdinal: 12,
          rowIds: [assistantRowId("t-10")],
          messages: [
            assistantWithBlocks("assistant-12", 12, "t-10", [
              textBlock("b-12", "stale"),
            ]),
          ],
        }),
      );

      // The new turn asks for its first catch-up rather than inheriting a spent
      // budget and giving up.
      expect(harness.rangeRequests.length).toBeGreaterThan(afterExhaustion + 1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not apply a buffered write twice onto a catch-up that already carries it", () => {
    // The gap between a delta ARRIVING and a delta being APPLIED. The stream
    // coordinator coalesces, so a frame sits in the buffer for a tick; a range
    // answer landing inside that tick folds into a window that has not absorbed
    // it yet. Everywhere else that is harmless, because the active arm keeps the
    // held copy and the buffered write lands on it a moment later - but the
    // repair path hands the served body the seat, and the host may have sliced
    // that body AFTER the very write still sitting in the buffer. Applying it
    // then writes the same text a second time.
    const harness = createDeferredFlushHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();

      streamTextDelta(harness, " missed");
      harness.flushDeltas();
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before", 1)],
        }),
      );
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(catchUpRequestId).not.toBe(firstRequestId);

      // Received but deliberately NOT flushed: this write is in the buffer for
      // the rest of the sequence, and the host has it.
      streamTextDelta(harness, " later");
      harness.callbacks().onIndexChanged(streamingRowEcho(2));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );
      const repairId = harness.lastRangeRequestId();
      expect(repairId).not.toBe(catchUpRequestId);

      // The host slices this one after ` later`, so the served body already
      // contains the write the client is still holding in its buffer.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: repairId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed later", 3)],
        }),
      );

      // The buffer's tick finally runs. Whatever it holds must not re-append
      // text the seated body already carries.
      harness.flushDeltas();

      expect(publishedTurnText(harness)).toBe("before missed later");
    } finally {
      harness.handle.dispose();
    }
  });

  it("scrolling through history does not spend the streaming row's repair budget", () => {
    // The reader scrolls away between a demotion and its re-plan, so the request
    // the planner mints next is for scrollback - which owes nothing and repairs
    // nothing. Charging the budget for those spent it on history: by the time
    // the reader came back to the streaming row there were no rounds left, and a
    // write that overtook its answer went unrepaired. Only a request covering
    // the rows the demotion opened is a repair.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      // Three row-10 requests outstanding, each followed by a history request
      // that takes the dedup slot.
      const rowTenRequestIds: string[] = [];
      let historyOrdinal = 14;
      for (let pass = 0; pass < 3; pass += 1) {
        harness.handle.store
          .getState()
          .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
        rowTenRequestIds.push(harness.lastRangeRequestId());
        historyOrdinal += 1;
        harness.handle.store.getState().reportVisibleTranscriptRange({
          fromOrdinal: historyOrdinal,
          toOrdinal: historyOrdinal + 1,
        });
      }

      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // Each row-10 answer demotes while the reader is in history, so its
      // re-plan is deduplicated and the NEXT request minted is scrollback.
      for (const requestId of rowTenRequestIds) {
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [turnBodyAt("before", 1)],
          }),
        );
        historyOrdinal += 1;
        harness.handle.store.getState().reportVisibleTranscriptRange({
          fromOrdinal: historyOrdinal,
          toOrdinal: historyOrdinal + 1,
        });
      }

      // Back to the streaming row, where a write overtakes the answer.
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const returnRequestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " later");
      harness.callbacks().onIndexChanged(streamingRowEcho(2));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: returnRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );

      // Rounds are still available, so the repair goes out and recovers.
      const repairId = harness.lastRangeRequestId();
      expect(repairId).not.toBe(returnRequestId);
      harness.callbacks().onRange(
        rangeFrame({
          requestId: repairId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed later", 3)],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed later");
    } finally {
      harness.handle.dispose();
    }
  });

  it("protects the drawn body from an old answer once no repair can follow", () => {
    // Forfeiting the held copy's authority buys a repair: the served body may be
    // older than what is drawn, and the catch-up afterwards is what makes that
    // acceptable. Past the cap no catch-up comes, so an answer still in flight
    // from before the write would replace the best body the client has with a
    // worse one and nothing would put it back.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const stragglerId = harness.lastRangeRequestId();
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 12, toOrdinal: 13 });
      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      let requestId = harness.lastRangeRequestId();

      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // Every catch-up is overtaken, so the budget runs out. Versionless
      // throughout: nothing on the records can order these copies.
      for (let round = 1; round <= 6; round += 1) {
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [versionlessTurnBody(`slice-${round}`)],
          }),
        );
        const next = harness.lastRangeRequestId();
        if (next === requestId) break;
        requestId = next;
        streamTextDelta(harness, ` later-${round}`);
        harness.callbacks().onIndexChanged(streamingRowEcho(round + 1));
      }
      const exhaustedText = publishedTurnText(harness);
      const exhaustedRequests = harness.rangeRequests.length;

      // The straggler, sliced before any of it.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: stragglerId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before")],
        }),
      );

      // The drawn body is not rolled backward, and nothing restarts the rounds.
      expect(publishedTurnText(harness)).toBe(exhaustedText);
      expect(harness.rangeRequests).toHaveLength(exhaustedRequests);
    } finally {
      harness.handle.dispose();
    }
  });

  it("an event the reducer rejects for another turn is not a write to this one", () => {
    // The mark is evidence about the STREAMING turn's body. A late
    // `usage.updated` from a previous turn is rejected by the reducer and
    // changes nothing, so counting it as a write retired a catch-up answer that
    // was current and spent a round asking the host to re-send an unchanged
    // body.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before", 1)],
        }),
      );
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(catchUpRequestId).not.toBe(firstRequestId);

      // Valid frame, previous turn, rejected by the reducer.
      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "usage.updated",
          blockId: "usage-t-8",
          turnId: "t-8",
          timestamp: 6,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      });

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );

      // The stream was quiet, so this answer is final: no third request.
      expect(publishedTurnText(harness)).toBe("before missed");
      expect(harness.lastRangeRequestId()).toBe(catchUpRequestId);
    } finally {
      harness.handle.dispose();
    }
  });

  it("installs the LAST authorised repair's own answer", () => {
    // The boundary between "may I authorise another repair" and "is this answer
    // the repair I authorised". Rounds are charged when a request is sent, so by
    // the time the third one's answer arrives the budget already reads as spent.
    // Asking the budget question there rejected the very body that repair went
    // out to fetch and certified the torn copy in its place - the whole episode
    // spending three round trips and then discarding the answer that closed it.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      // A seats `before` and asks for B.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before")],
        }),
      );

      // Two overtaken repairs, which spend the first two rounds.
      const overtaken = [
        { delta: " later-1", slice: "before missed" },
        { delta: " later-2", slice: "before missed later-1" },
      ];
      let requestId = harness.lastRangeRequestId();
      overtaken.forEach((step, index) => {
        streamTextDelta(harness, step.delta);
        harness.callbacks().onIndexChanged(streamingRowEcho(index + 2));
        harness.callbacks().onRange(
          rangeFrame({
            requestId,
            epoch: 1,
            fromOrdinal: 10,
            rowIds: [assistantRowId("t-9")],
            messages: [versionlessTurnBody(step.slice)],
          }),
        );
        const next = harness.lastRangeRequestId();
        expect(next).not.toBe(requestId);
        requestId = next;
      });

      // The third and last permitted repair, asked and answered across a quiet
      // stream, carrying everything.
      harness.callbacks().onRange(
        rangeFrame({
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [versionlessTurnBody("before missed later-1 later-2")],
        }),
      );

      expect(publishedTurnText(harness)).toBe("before missed later-1 later-2");
      // And it settled: no fourth request, and the row is fresh.
      expect(harness.lastRangeRequestId()).toBe(requestId);
      const settled = harness.handle.store.getState().transcriptWindow;
      expect(settled.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("reconciles SEVERAL writes buffered across a whole repair episode", () => {
    // The flush seam again, widened: two writes sit in the coordinator's buffer
    // across an entire repair round rather than one across a single seat. The
    // drain has to apply both before the fold, the version comparison has to see
    // the body they produced, and the episode still has to converge on the full
    // text - not on the catch-up's older slice, and not on it twice.
    const harness = createDeferredFlushHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();

      // Dropped: flushed while nothing holds the turn.
      streamTextDelta(harness, " missed");
      harness.flushDeltas();
      harness.callbacks().onIndexChanged(streamingRowEcho(1));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before", 1)],
        }),
      );
      const catchUpRequestId = harness.lastRangeRequestId();
      expect(catchUpRequestId).not.toBe(firstRequestId);

      // Two writes the client has but has not applied, spanning the catch-up.
      streamTextDelta(harness, " later-1");
      harness.callbacks().onIndexChanged(streamingRowEcho(2));
      streamTextDelta(harness, " later-2");
      harness.callbacks().onIndexChanged(streamingRowEcho(3));

      harness.callbacks().onRange(
        rangeFrame({
          requestId: catchUpRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed", 2)],
        }),
      );

      // The drain applied both buffered writes before the seat, so the drawn
      // body carries them and the older slice does not displace it.
      expect(publishedTurnText(harness)).toBe("before later-1 later-2");
      const repairId = harness.lastRangeRequestId();
      expect(repairId).not.toBe(catchUpRequestId);

      // The quiet repair carries everything the host has.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: repairId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [turnBodyAt("before missed later-1 later-2", 4)],
        }),
      );
      harness.flushDeltas();

      expect(publishedTurnText(harness)).toBe("before missed later-1 later-2");
      expect(harness.lastRangeRequestId()).toBe(repairId);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not roll the drawn body back for an answer that can queue no repair", () => {
    // A STEER row of the streaming turn carries the whole turn's records - its
    // projection sources the turn's messages - so an answer serving only that
    // row passes the records test. But it is not one of the turn's ASSISTANT
    // rows, so it yields no ordinal to retire: the demotion never happens, no
    // repair is queued, and nothing is logged. Forfeiting the held copy's
    // authority there installed an older served body over the drawn one with no
    // gap left to re-request it - silently, and only for versionless bodies.
    // No repair possible means no forfeit.
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      harness.callbacks().onSkeletonChunk(splitTurnSkeleton());
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const firstRequestId = harness.lastRangeRequestId();
      streamTextDelta(harness, " missed");
      // Named with the SLICE's row id: a bare `assistant:` id would contradict
      // this skeleton and void the index instead of echoing.
      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 10,
                  entry: {
                    rowId: assistantSliceRowId("t-9", 0, true),
                    createdAt: 10,
                    role: "assistant",
                    byteLength: 4096,
                    bodyDigest: "d10-echo",
                  },
                },
              ],
            },
          ],
        }),
      );

      // The turn is unsound and its body is drawn from the stream.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: firstRequestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantSliceRowId("t-9", 0, true)],
          messages: [versionlessTurnBody("before")],
        }),
      );
      streamTextDelta(harness, " later");
      const drawn = publishedTurnText(harness);
      expect(drawn).toBe("before later");
      const requestsBefore = harness.rangeRequests.length;

      // An answer for the steer row alone, carrying an older copy of the turn.
      harness.callbacks().onRange(
        rangeFrame({
          requestId: harness.lastRangeRequestId(),
          epoch: 1,
          fromOrdinal: 11,
          rowIds: ["steer:q-9"],
          messages: [versionlessTurnBody("before missed")],
        }),
      );

      // The drawn body survives. Rolling it back would be a regression against
      // base, and the branch that did it queued nothing to put it right.
      expect(publishedTurnText(harness)).toBe(drawn);
      // The steer answer creates no obligation of its own: the only request
      // minted after it is the re-ask for ordinal 10, the turn's own row, whose
      // repair was owed before this answer and which this answer did not serve.
      expect(harness.rangeRequests.length).toBe(requestsBefore + 1);
      const reAsk = harness.rangeRequests.at(-1);
      expect(reAsk?.fromOrdinal).toBe(10);
      expect(reAsk?.toOrdinal).toBe(10);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a streaming echo against a HELD turn owes no refresh", () => {
    // The refresh exists only for the unheld seat. When the tail already
    // holds the turn, the deltas rewrote that copy in place, so the answer is
    // current and seats once with nothing further asked.
    const harness = createWindowedHarness();
    try {
      seatedTailHoldingTurn(harness, "t-9");
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestId = harness.lastRangeRequestId();

      for (let revision = 1; revision <= 3; revision += 1) {
        harness.callbacks().onIndexChanged(streamingRowEcho(revision));
      }
      harness.callbacks().onRange(
        rangeFrame({
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("t-9")],
          messages: [assistantWithBlocks("assistant-10", 10, "t-9", [])],
        }),
      );

      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.spans.some((span) => span.fromOrdinal === 10)).toBe(true);
      expect(harness.rangeRequests).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("logs every discarded range answer", () => {
    // A discarded answer has no other trace on screen or in the desktop log;
    // the placeholder it would have filled looks like one nothing has asked
    // for yet. The warning is the only way the loop above is diagnosable
    // from outside.
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const harness = createWindowedHarness();
    try {
      seatedTail(harness);
      raiseActiveTurn(harness.callbacks(), "t-9");

      harness.handle.store
        .getState()
        .reportVisibleTranscriptRange({ fromOrdinal: 10, toOrdinal: 11 });
      const requestId = harness.lastRangeRequestId();

      // A different turn's row: not an echo, so the in-flight request is
      // superseded and its answer must be discarded - and logged.
      harness.callbacks().onIndexChanged(
        indexChangedFrame({
          epoch: 1,
          rowCount: 40,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [
                {
                  ordinal: 10,
                  entry: {
                    rowId: assistantRowId("other-turn"),
                    createdAt: 10,
                    role: "assistant",
                    byteLength: 4096,
                    bodyDigest: "d10-other",
                  },
                },
              ],
            },
          ],
        }),
      );
      harness.callbacks().onRange(
        rangeFrame({
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rowIds: [assistantRowId("other-turn")],
          messages: [assistantWithBlocks("assistant-10", 10, "other-turn", [])],
        }),
      );

      expect(warn).toHaveBeenCalledWith(
        "[transcript] discarded a range answer as stale",
        expect.objectContaining({
          chatId: CHAT_ID,
          requestId,
          epoch: 1,
          fromOrdinal: 10,
          rows: 1,
          awaited: true,
        }),
      );

      // An answer framed against an epoch this window has left never seats
      // either, and is logged under its own reason.
      warn.mockClear();
      const lateRequestId = harness.lastRangeRequestId();
      harness.callbacks().onRange(
        rangeFrame({
          requestId: lateRequestId,
          epoch: 0,
          fromOrdinal: 10,
          rowIds: [assistantRowId("other-turn")],
          messages: [assistantWithBlocks("assistant-10", 10, "other-turn", [])],
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        "[transcript] discarded a range answer unseated",
        expect.objectContaining({ requestId: lateRequestId, windowEpoch: 1 }),
      );
    } finally {
      warn.mockRestore();
      harness.handle.dispose();
    }
  });
});

describe("accumulated-change chunks", () => {
  it("assembles chunks in order and lets a fresh first chunk replace the set", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });

      // The chunks follow a windowed snapshot on the wire, and the store now
      // requires that: a chunk arriving on a session that has NOT negotiated
      // the windowed line is a straggler from an abandoned epoch, and seating
      // it would leave the panel serving rows the legacy line has no way to
      // clear.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 3,
        }),
      );

      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts"), summary("b.ts")],
          isFinal: false,
        },
      });
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 2,
          generation: 1,
          summaries: [summary("c.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);

      // A re-streamed set starts at 0 and must REPLACE, not append - otherwise
      // a reconnect doubles every row the panel shows.
      //
      // The snapshot that carries the new epoch comes first, because on the
      // wire it always does: the host emits these chunks only from
      // `reconcileWindowedIndex`, which runs inside
      // `emitWindowedSnapshotToSubscriber` and after the snapshot frame. A
      // chunk naming an epoch the client has never been told about is
      // therefore not a re-stream but a straggler, and is dropped as one.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 5,
          fromIndex: 0,
          generation: 2,
          summaries: [summary("z.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["z.ts"]);
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * A chunk that starts PAST the assembled end is one whose predecessor was
   * dropped. `slice(0, fromIndex)` cannot say so - on a shorter array it
   * returns the whole thing and appends, so every entry from there on sits
   * BELOW the index the host gave it and the panel attributes each row's
   * digest and counts to the wrong file.
   */
  it("drops an accumulated chunk whose predecessor was lost, rather than misplacing it", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 4,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts")],
          isFinal: false,
        },
      });
      // fromIndex 3 against an assembled length of 1: chunk 2 never arrived.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 3,
          generation: 1,
          summaries: [summary("d.ts")],
          isFinal: true,
        },
      });

      const state = harness.handle.store.getState();
      // "d.ts" is NOT seated at index 1 wearing "b.ts"'s position - and the
      // partial assembly ("a.ts" alone, 1 of 4) is never published either: a
      // generation is assembled off-screen and swaps in only once whole, so
      // the panel shows the previous complete set (here: nothing) rather than
      // flashing a partial replacement.
      expect(
        state.accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual([]);
      // And the shortfall stays visible, which is what holds "Review all" back.
      expect(
        state.accumulatedFileChangeCount -
          state.accumulatedFileChangeSummaries.length,
      ).toBe(4);
      // Dropping alone would strand the panel: the host records the set it
      // just sent, so a chunk lost in transit leaves it believing this
      // subscriber holds that generation - ordinary traffic over an unchanged
      // set sends nothing. The resnapshot is the restart.
      expect(harness.resnapshotCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * A replacement generation assembles off-screen and swaps in atomically.
   * Publishing its first chunk repainted the panel with a partial set - the
   * "2 files changed" flash mid-restream over a complete 6-file set - so the
   * previous complete generation stays published until the replacement
   * reaches the authoritative count.
   */
  it("holds the previous complete summary set until the replacement generation is whole", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 3,
        }),
      );
      // Generation 1 completes and publishes.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts"), summary("b.ts"), summary("c.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(true);

      // Generation 2's first chunk covers 1 of 3: the published set must not
      // move, and the un-seated flag is what keeps the completion watchdog
      // measuring the assembly rather than the retained array.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 2,
          summaries: [summary("x.ts")],
          isFinal: false,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(false);

      // The generation completes to the authoritative count: the set swaps
      // atomically.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 1,
          generation: 2,
          summaries: [summary("y.ts"), summary("z.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["x.ts", "y.ts", "z.ts"]);
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * The un-seat this store used to skip. A chunk of a LATER generation whose
   * `fromIndex` is not 0 cannot itself seat - its predecessors, including that
   * generation's own first chunk, were dropped - but the generation WAS
   * observed on the ledger, so the trust flags must publish that a
   * replacement is running. The previous shape returned before publishing,
   * leaving `accumulatedSummaryGenerationSeated` vouching for the SUPERSEDED
   * generation while its replacement was already known to be in flight.
   */
  it("un-seats when a later generation's chunk cannot itself seat", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 3,
        }),
      );
      // Generation 1 completes and seats.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts"), summary("b.ts"), summary("c.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(true);

      const before = harness.resnapshotCount();

      // Generation 2's first OBSERVED chunk is not index 0: everything before
      // it in that generation - including its real first chunk - was dropped.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 1,
          generation: 2,
          summaries: [summary("y.ts")],
          isFinal: false,
        },
      });

      // The published set is unchanged - the chunk cannot seat at the wrong
      // offset - but the trust flags must stop vouching for it as settled.
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(false);
      expect(
        harness.handle.store.getState().accumulatedSummaryAssemblyStarted,
      ).toBe(true);
      // And the restream is what recovers the dropped predecessor.
      expect(harness.resnapshotCount()).toBe(before + 1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not seat a non-final chunk whose length matches a transiently stale count", () => {
    // `accumulatedFileChangeCount` is an aux field and aux is
    // last-write-wins, so a delayed same-epoch snapshot restores an older,
    // smaller count for a frame. A non-final prefix of the generation being
    // assembled can have exactly that length - and publishing on the
    // coincidence seats the generation permanently: later chunks push the
    // assembly past the count, it never matches again, the flag is never
    // cleared, and the completion watchdog then measures the published prefix
    // against the stale count, agrees, and disarms. The rest of the summaries
    // are hidden for the life of the connection.
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      const snapshotWithCount = (count: number): void => {
        harness.callbacks().onWindowedSnapshot(
          windowedSnapshot({
            epoch: 4,
            rowCount: 1,
            tailFromOrdinal: 0,
            tailMessages: [userMessage("m-0", 0)],
            accumulatedFileChangeCount: count,
          }),
        );
      };
      const chunk = (
        fromIndex: number,
        summaries: readonly ChatAccumulatedFileChangeSummary[],
        isFinal: boolean,
      ): void => {
        harness.callbacks().onAccumulatedChanges({
          kind: "accumulatedChanges",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          chunk: {
            epoch: 4,
            fromIndex,
            generation: 2,
            summaries: [...summaries],
            isFinal,
          },
        });
      };

      snapshotWithCount(3);
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts"), summary("b.ts"), summary("c.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(true);

      // The delayed snapshot rewinds the count to a length the next prefix
      // happens to match.
      snapshotWithCount(1);
      chunk(0, [summary("x.ts")], false);

      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(false);

      // The gate blocks a coincidence, not a completion. The count is STILL
      // the stale `1` here and the assembly is now two entries long, and the
      // final chunk publishes anyway: `isFinal` is the host declaring the
      // generation whole, which is the one thing an aux field cannot say.
      //
      // Refusing here instead would strand a complete generation the client
      // already holds behind a transient value - the previous set rendering
      // indefinitely with no route back, since the host believes this
      // subscriber was already sent this generation and re-sends nothing.
      chunk(1, [summary("y.ts")], true);

      expect(
        harness.handle.store.getState().accumulatedSummaryGenerationSeated,
      ).toBe(true);
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["x.ts", "y.ts"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the watchdog armed when an aux re-broadcast rewinds the count mid-assembly", () => {
    // The count is aux and aux is last-write-wins, so an aux-only re-broadcast
    // can restore an older, smaller value for a frame - zero, before the first
    // generation has published anything. Measuring completeness against THAT
    // agrees with the still-empty published array (`0 !== 0` is false) and
    // disarms the stall watchdog on a generation that delivered nothing, so
    // the summaries stay hidden for the rest of the connection.
    //
    // What proves a delivery is owed is holding an assembly no chunk has
    // vouched for, and that is true whatever the count currently says.
    vi.useFakeTimers();
    const harness = createWindowedHarness();
    try {
      const snapshotWithCount = (
        count: number,
        indexRevision: number | null,
      ): void => {
        harness.callbacks().onWindowedSnapshot(
          windowedSnapshot({
            epoch: 6,
            rowCount: 1,
            tailFromOrdinal: 0,
            tailMessages: [userMessage("m-0", 0)],
            accumulatedFileChangeCount: count,
            indexRevision,
          }),
        );
      };

      snapshotWithCount(3, null);
      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 6,
          fromOrdinal: 0,
          entries: [
            {
              rowId: "row-0",
              createdAt: 1,
              role: "user",
              byteLength: 10,
              bodyDigest: "d0",
            },
          ],
          isFinal: true,
        },
      });
      const before = harness.resnapshotCount();

      // The first generation opens and then STOPS - its last frame is lost.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 6,
          fromIndex: 0,
          generation: 1,
          summaries: [
            {
              filePath: "a.ts",
              operation: "edit",
              diffSource: "snapshot",
              reason: "snapshot",
              undoable: true,
              hasContents: true,
              digest: "d-a.ts",
              counts: { additions: 1, deletions: 0 },
            },
          ],
          isFinal: false,
        },
      });

      // At a LIVE revision, so it carries no chunks and leaves the assembly in
      // place - the one shape that can rewind the count without also
      // announcing the re-stream that would repair it.
      snapshotWithCount(0, 1);

      // Exactly one idle window. The watchdog re-arms behind its own
      // resnapshot, so a longer advance would count the retries too and say
      // nothing about whether the FIRST deadline survived the rewind.
      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS + 1);

      expect(harness.resnapshotCount()).toBe(before + 1);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  /**
   * An aux-only re-broadcast - a queue change, an approval - re-sends the
   * snapshot against summaries the host has already sent, and it never re-sends
   * an unchanged set. So a snapshot is not proof that a re-stream is coming,
   * and clearing the assembled summaries on one empties the panel for the rest
   * of the session while the header goes on counting files it can no longer
   * list.
   */
  it("keeps the assembled summaries across an aux-only snapshot re-broadcast", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts")],
          isFinal: true,
        },
      });
      // Same epoch, same rows: nothing here re-streams the summaries.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );

      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts"]);
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * The generation counter is the host's PER-SUBSCRIBER one, so a reconnect
   * mints a fresh subscriber that starts over at 1 - and one re-stream per
   * subscriber is the modal case, which makes `1 == 1` the modal collision.
   * A colliding generation reads as "the stream I am already assembling", so
   * the new stream's chunks splice into the RETAINED previous-generation array.
   *
   * The failure needs all three: a reconnect, a colliding generation, AND the
   * new stream's index-0 chunk dropped. With that chunk delivered the array is
   * rebuilt correctly on its own (`slice(0, 0) + summaries`), which is why a
   * plain reconnect fixture passes against the bug.
   */
  it("does not splice a restarted generation into the array a previous connection left", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      const connectedSnapshot = (): void => {
        harness.callbacks().onWindowedSnapshot(
          windowedSnapshot({
            epoch: 4,
            rowCount: 1,
            tailFromOrdinal: 0,
            tailMessages: [userMessage("m-0", 0)],
            accumulatedFileChangeCount: 3,
          }),
        );
      };

      // First connection: a complete stream from the first subscriber's
      // generation 1.
      connectedSnapshot();
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts"), summary("b.ts")],
          isFinal: false,
        },
      });
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 2,
          generation: 1,
          summaries: [summary("c.ts")],
          isFinal: true,
        },
      });
      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);

      // The reconnect. Same transcript, so the same epoch - `indexRevision`
      // is null because the host holds no index for the NEW subscriber and is
      // about to rebuild one.
      connectedSnapshot();
      const resnapshotsBeforeTheGap = harness.resnapshotCount();

      // The second subscriber's index-0 chunk - `["x.ts", "y.ts"]` - is
      // DROPPED here, and its generation restarted at 1.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 2,
          generation: 1,
          summaries: [summary("z.ts")],
          isFinal: true,
        },
      });

      const state = harness.handle.store.getState();
      // NOT ["a.ts", "b.ts", "z.ts"] - a prefix of the previous connection's
      // set wearing the new one's tail, at exactly the authoritative length, so
      // both the gap check and the count watchdog would read it as healthy
      // while every content fetch against the stale digests returns `stale`.
      expect(
        state.accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      // And the recovery is asked for, because nothing on the ordinary path
      // re-sends these chunks.
      expect(harness.resnapshotCount()).toBe(resnapshotsBeforeTheGap + 1);
    } finally {
      harness.handle.dispose();
    }
  });

  /**
   * The other half of the same fix, and the reason the reset is keyed on
   * `indexRevision === null` rather than on "a snapshot arrived".
   *
   * An aux-only re-broadcast reports the revision the host is HOLDING for this
   * subscriber and sends no chunks at all. Resetting the tracker there would
   * make the next chunk of the stream still in flight look like a foreign
   * generation and buy a `requestSummaryRestream()` - once per aux frame, for
   * as long as aux traffic keeps arriving during a long summary stream.
   */
  it("keeps assembling across a held-revision snapshot instead of restreaming", () => {
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 3,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("a.ts"), summary("b.ts")],
          isFinal: false,
        },
      });

      // The aux-only frame, mid-stream. The revision matches the one this
      // client holds, so the window is untouched and no skeleton follows.
      const auxFrame = windowedSnapshot({
        epoch: 4,
        rowCount: 1,
        tailFromOrdinal: 0,
        tailMessages: [userMessage("m-0", 0)],
        accumulatedFileChangeCount: 3,
      });
      harness.callbacks().onWindowedSnapshot({
        ...auxFrame,
        snapshot: { ...auxFrame.snapshot, indexRevision: 0 },
      });

      // The rest of the stream that was already on the wire.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 2,
          generation: 1,
          summaries: [summary("c.ts")],
          isFinal: true,
        },
      });

      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(harness.resnapshotCount()).toBe(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("drops a chunk from an abandoned epoch instead of letting it replace the set", () => {
    // These are the one windowed stream whose chunks never pass through a
    // function holding the epoch - `applySkeletonChunk` and `applyRangeResponse`
    // both open with that comparison and can, because they fold into the
    // window; these land in a store field of their own.
    //
    // A stale chunk is not merely ignorable noise. It begins at index 0, which
    // this handler reads as "a fresh set starts here", so an abandoned epoch's
    // paths and digests would REPLACE the current ones - and at a matching
    // length the completeness check would call that the whole story.
    const harness = createWindowedHarness();
    try {
      const summary = (filePath: string): ChatAccumulatedFileChangeSummary => ({
        filePath,
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        hasContents: true,
        digest: `d-${filePath}`,
        counts: { additions: 1, deletions: 0 },
      });
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("current.ts")],
          isFinal: true,
        },
      });

      // A resnapshot rebases the transcript onto a new coordinate space.
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 5,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [userMessage("m-0", 0)],
          accumulatedFileChangeCount: 1,
        }),
      );

      // Still in flight when the epoch turned over.
      harness.callbacks().onAccumulatedChanges({
        kind: "accumulatedChanges",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromIndex: 0,
          generation: 1,
          summaries: [summary("abandoned.ts")],
          isFinal: true,
        },
      });

      expect(
        harness.handle.store
          .getState()
          .accumulatedFileChangeSummaries.map((entry) => entry.filePath),
      ).toEqual(["current.ts"]);
    } finally {
      harness.handle.dispose();
    }
  });
});

describe("a record that arrives with no ordinal", () => {
  /**
   * The host emits `messageAccepted` / `eventAppended` the moment the append
   * commits, and moves the INDEX only on its next snapshot - verified against
   * `chat-session-manager.ts`, where the accept path broadcasts the body and
   * calls no `broadcastSnapshot`. So a record genuinely exists on the client
   * with nowhere in the ordinal space to live, and it has to survive every
   * windowed frame that arrives before the index catches up.
   */
  function seatHydratedSnapshot(harness: WindowedHarness): void {
    harness.callbacks().onWindowedSnapshot(
      windowedSnapshot({
        epoch: 4,
        rowCount: 1,
        tailFromOrdinal: 0,
        tailMessages: [userMessage("m-0", 0)],
        accumulatedFileChangeCount: 0,
      }),
    );
  }

  it("survives a skeleton chunk, which is what the old code got wrong", () => {
    // Before write-through, `onMessageAccepted` appended to `state.messages`
    // and the next `publishWindowedTranscript` - triggered by ANY windowed
    // frame - rebuilt that array from the window and dropped it.
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-live", 9),
      });
      expect(
        harness.handle.store
          .getState()
          .messages.map((message) => message.messageId),
      ).toEqual(["m-0", "m-live"]);

      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromOrdinal: 0,
          entries: [
            {
              rowId: "row-0",
              createdAt: 1,
              role: "user",
              byteLength: 10,
              bodyDigest: "d0",
            },
          ],
          isFinal: true,
        },
      });

      expect(
        harness.handle.store
          .getState()
          .messages.map((message) => message.messageId),
      ).toEqual(["m-0", "m-live"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("routes an appended EVENT the same way", () => {
    // Same defect class as the message above, and it needs its own case: the
    // two appliers are separate branches, so a fix to one leaves the other
    // writing into an array the next frame rebuilds.
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onEventAppended({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          eventId: "e-live",
          type: "turn.completed",
          timestamp: 9,
          clientActionId: null,
          actor: null,
          message: null,
          turnId: "turn-1",
          messageId: null,
          queueItemId: null,
          approvalId: null,
          blockId: null,
          severity: "info",
          metadata: null,
        },
      });
      expect(
        harness.handle.store.getState().events.map((event) => event.eventId),
      ).toEqual(["e-live"]);

      harness.callbacks().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: {
          epoch: 4,
          fromOrdinal: 0,
          entries: [
            {
              rowId: "row-0",
              createdAt: 1,
              role: "user",
              byteLength: 10,
              bodyDigest: "d0",
            },
          ],
          isFinal: true,
        },
      });

      expect(
        harness.handle.store.getState().events.map((event) => event.eventId),
      ).toEqual(["e-live"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("is superseded, not duplicated, once a range brings the placed copy", () => {
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-live", 9),
      });

      // The index catches up and names a row for it. That un-hydrates the
      // tail, which is what makes the client ask - a `range` only ever arrives
      // in answer to a `loadRange`, so the fetch has to be real for the
      // response below to be one the host could send.
      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 4,
        rowCount: 2,
        indexRevision: 1,
        changes: [
          {
            type: "appended",
            entries: [
              {
                rowId: "row-1",
                createdAt: 9,
                role: "user",
                byteLength: 128,
                bodyDigest: "d1",
              },
            ],
          },
        ],
      });
      expect(harness.rangeRequests).toHaveLength(1);

      // The host's own copy, now with an ordinal.
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0", "row-1"],
          messages: [userMessage("m-0", 0), userMessage("m-live", 9)],
          events: [],
          rowContext: {},
          reachedStart: true,
          reachedEnd: true,
        },
      });

      const state = harness.handle.store.getState();
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-0",
        "m-live",
      ]);
      // Pruned rather than kept alongside: a live copy that outlived its
      // hydration would reappear the moment its span was evicted.
      expect(state.transcriptWindow.liveMessages).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("is dropped on a rebase, because the coordinate space changed", () => {
    const harness = createWindowedHarness();
    try {
      seatHydratedSnapshot(harness);
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-live", 9),
      });
      expect(
        harness.handle.store.getState().transcriptWindow.liveMessages,
      ).toHaveLength(1);

      harness.callbacks().onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 5,
        rowCount: 1,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      });

      // A `reindexed` says every ordinal now names a different row. Anything
      // the client was holding unplaced says nothing about the new space, and
      // the resnapshot re-delivers whatever is real.
      expect(
        harness.handle.store.getState().transcriptWindow.liveMessages,
      ).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not take the window path on the legacy line", () => {
    // No windowed snapshot ever arrived, so `messageAccepted` must still
    // append to `state.messages` exactly as it always has.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedMessage("m-legacy", 1),
      });
      const state = harness.handle.store.getState();
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-legacy",
      ]);
      expect(state.transcriptWindow.liveMessages).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});

/**
 * A row-targeted delta names a row that ALREADY has an ordinal, which is what
 * separates these from `messageAccepted`: the question is not where the record
 * goes, it is whether the write survives.
 *
 * On this line it only survives in the WINDOW. `state.messages` is rebuilt from
 * the window by the next windowed frame of any kind, so an applier that spliced
 * the published array would look correct until the next frame - and the next
 * frame is a skeleton chunk on any reconnect, or simply the next appended
 * event.
 */
describe("a row-targeted delta on the windowed line", () => {
  function resolutionCount(harness: WindowedHarness): number {
    const row = harness.handle.store
      .getState()
      .messages.find((message) => message.messageId === "a-1");
    if (row === undefined || row.role !== "assistant") return -1;
    return row.imageResolutions.length;
  }

  function seedAndResolve(harness: WindowedHarness): void {
    harness.callbacks().onWindowedSnapshot(
      windowedSnapshot({
        epoch: 4,
        rowCount: 2,
        tailFromOrdinal: 0,
        tailMessages: [userMessage("m-1", 1), assistantMessage("a-1", 2)],
        accumulatedFileChangeCount: 0,
      }),
    );
    harness.callbacks().onBlockDelta(
      createImageResolutionUpdatedFrame({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "image_resolution.updated",
          blockId: "a-1",
          messageId: "a-1",
          timestamp: 3,
          turnId: "turn-1",
          entry: {
            source: "chart.png",
            canonicalSource: "chart.png",
            state: "resolved",
            attachmentHash: "hash-1",
            mediaType: "image/png",
            width: null,
            height: null,
          },
        },
      }),
    );
  }

  it("survives the republish that the next windowed frame performs", () => {
    const harness = createWindowedHarness();
    try {
      seedAndResolve(harness);
      expect(resolutionCount(harness)).toBe(1);

      // The frame that used to erase it. Any windowed frame would do; an
      // appended event is the one that needs no reconnect to arrive.
      harness.callbacks().onEventAppended(appendedEvent("e-1"));

      expect(resolutionCount(harness)).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("carries a steer-split block through to the frozen row, and keeps it", () => {
    // Consumer 10. Three appliers share `rewriteMessageInPlace`, and sharing a
    // helper is not the same as using it - a mutation that un-wires THIS one
    // passed every test until this existed.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 3,
          tailFromOrdinal: 0,
          tailMessages: [
            assistantWithBlocks("a-frozen", 1, "turn-1", [
              {
                type: "text",
                blockId: "b-1",
                status: "streaming",
                timestamp: 1,
                text: "before",
                providerNotice: null,
              },
            ]),
            // The steer bubble sits between the split siblings.
            userMessage("m-steer", 2),
            assistantWithBlocks("a-continuation", 3, "turn-1", []),
          ],
          accumulatedFileChangeCount: 0,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "turn-1");

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "text.delta",
          blockId: "b-1",
          timestamp: 4,
          delta: " and after",
        },
      });

      const frozenBlock = (): AssistantBlocks[number] | undefined =>
        blockOf(
          harness.handle.store
            .getState()
            .messages.find((message) => message.messageId === "a-frozen"),
          "b-1",
        );
      const carried = frozenBlock();
      expect(carried?.type === "text" ? carried.text : "").toBe(
        "before and after",
      );

      harness.callbacks().onEventAppended(appendedEvent("e-carry"));
      const survived = frozenBlock();
      expect(survived?.type === "text" ? survived.text : "").toBe(
        "before and after",
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("routes a detached background terminal to its settled row, and keeps it", () => {
    // Consumer 8, the third applier. Its owner row belongs to an ALREADY
    // SETTLED turn, which is what makes it a row-targeted delta at arbitrary
    // history rather than a tail write.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [
            assistantWithBlocks("a-settled", 2, "turn-settled", [
              {
                type: "command",
                blockId: "bg-command",
                status: "streaming",
                timestamp: 2,
                command: "sleep 20 && echo done",
                cwd: "/tmp",
                exitCode: null,
                backgroundTask: true,
                stopped: false,
              },
            ]),
          ],
          accumulatedFileChangeCount: 0,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "turn-1");

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "command.completed",
          blockId: "bg-command",
          timestamp: 30,
          command: "sleep 20 && echo done",
          exitCode: 0,
          backgroundTask: true,
        },
      });

      const settledBlock = (): AssistantBlocks[number] | undefined =>
        blockOf(
          harness.handle.store
            .getState()
            .messages.find((message) => message.messageId === "a-settled"),
          "bg-command",
        );
      const completed = settledBlock();
      expect(completed?.type === "command" ? completed.exitCode : null).toBe(0);

      harness.callbacks().onEventAppended(appendedEvent("e-detached"));
      const survived = settledBlock();
      expect(survived?.type === "command" ? survived.exitCode : null).toBe(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the ACTIVE turn's streamed blocks across an appended event", () => {
    // Consumer 11a - missed by the sweep, and the worst of the set. This row
    // is at the tail and hydrated by construction, which is exactly why the
    // bug reads as impossible: being hydrated is what makes the write LAND,
    // not what makes it SURVIVE. Every mid-turn event republished `messages`
    // from the window and took the streamed text with it.
    const harness = createWindowedHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        windowedSnapshot({
          epoch: 4,
          rowCount: 1,
          tailFromOrdinal: 0,
          tailMessages: [
            assistantWithBlocks("a-live", 1, "turn-1", [
              {
                type: "text",
                blockId: "b-live",
                status: "streaming",
                timestamp: 1,
                text: "start",
                providerNotice: null,
              },
            ]),
          ],
          accumulatedFileChangeCount: 0,
        }),
      );
      raiseActiveTurn(harness.callbacks(), "turn-1");

      harness.callbacks().onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "text.delta",
          blockId: "b-live",
          timestamp: 4,
          delta: " and more",
        },
      });

      const streamedText = (): string => {
        const block = blockOf(
          harness.handle.store
            .getState()
            .messages.find((message) => message.messageId === "a-live"),
          "b-live",
        );
        return block?.type === "text" ? block.text : "";
      };
      expect(streamedText()).toBe("start and more");

      harness.callbacks().onEventAppended(appendedEvent("e-mid-turn"));
      expect(streamedText()).toBe("start and more");

      // And it took the DEFERRED charge. Both charge modes are behaviourally
      // identical - the eager one is simply the wrong cost on a growing row
      // written per delta - so nothing else here can tell them apart, and a
      // silent switch back to eager would be an invisible regression.
      expect(
        harness.handle.store.getState().transcriptWindow
          .unsettledByteMessageIds,
      ).toEqual(["a-live"]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("lands in the window itself, not only in the published array", () => {
    // The stronger statement, and the one that does not depend on which frame
    // happens to arrive next: the span holding the row carries the resolution.
    const harness = createWindowedHarness();
    try {
      seedAndResolve(harness);
      const window = harness.handle.store.getState().transcriptWindow;
      const span = window.spans[0];
      const row = spanMessages(window, span).find(
        (message) => message.messageId === "a-1",
      );
      expect(
        row?.role === "assistant" ? row.imageResolutions : [],
      ).toHaveLength(1);
    } finally {
      harness.handle.dispose();
    }
  });
});
