import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  STREAM_COMPLETION_TIMEOUT_MS,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";

/**
 * # The append republish interleave
 *
 * The host's append broadcast emits, in one synchronous pass and in this
 * order: the shared frames (`messageAccepted` / `eventAppended`), then the
 * bounded SNAPSHOT - stamped with the post-append `rowCount` but the
 * subscriber's PRE-delta `indexRevision` - and then the `indexChanged` delta
 * for that same append. So the delta always lands on a window whose
 * `rowCount` already includes its rows.
 *
 * Read naively against `window.rowCount`, every such delta has the
 * `0 !== appendedRows` signature of a lost frame. The client shipped exactly
 * that misreading once: it voided the window and requested a resnapshot on
 * EVERY append, which under an active turn is a transcript that is blank for
 * as long as the stream keeps appending - the "launch a task, see an empty
 * chat" regression. The first fixture replays the host's real emission order,
 * captured from a live `ChatSessionManager` running the launch flow, and pins
 * that the window survives it; the second holds that order and varies only the
 * one field the wire lets a producer omit.
 */

const EPIC_ID = "epic-r";
const CHAT_ID = "chat-r";
const OWNER_ID = "owner-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

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
 * The `messageAccepted` frame's own message type. NOT the `Message` above:
 * the two are structurally identical and nominally distinct (the frame's
 * resolves through the subscribe union's schema instance), so a fixture typed
 * as one cannot be passed where the other is expected.
 */
type AcceptedMessage = Parameters<
  ChatStreamCallbacks["onMessageAccepted"]
>[0]["message"];

function acceptedUserMessage(
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

function assistantMessage(messageId: string, timestamp: number): Message {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude",
      displayName: "Claude",
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

function skeletonEntry(
  rowId: string,
  ordinal: number,
  role: "user" | "assistant",
): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role,
    byteLength: 128,
    bodyDigest: `d-${rowId}`,
  };
}

type WindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];

/**
 * A snapshot as the append republish stamps it: the CURRENT `rowCount` and
 * tail, at the subscriber's held (pre-delta) `indexRevision`.
 *
 * `tailRowIds` is what the host actually sends - `chat-session-manager.ts`
 * always names the tail's rows - and it is passed explicitly here rather than
 * derived, so a fixture cannot quietly drift onto the positional fallback the
 * live producer never uses. The one case that DOES omit it is the fallback's
 * own test below, which says so.
 */
function republishSnapshot(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly indexRevision: number | null;
  readonly tailMessages: readonly Message[];
  readonly tailRowIds: readonly string[] | undefined;
}): WindowedSnapshotFrame {
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
      runStatus: "running",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      transcriptEpoch: input.epoch,
      rowCount: input.rowCount,
      indexRevision: input.indexRevision,
      tail: {
        fromOrdinal: 0,
        rowIds:
          input.tailRowIds === undefined ? undefined : [...input.tailRowIds],
        messages: [...input.tailMessages],
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

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly resnapshotCount: () => number;
  readonly rangeRequestCount: () => number;
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  let resnapshots = 0;
  let rangeRequests = 0;
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: () => {},
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => {
          rangeRequests += 1;
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
    resnapshotCount: () => resnapshots,
    rangeRequestCount: () => rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

describe("the append republish interleave (bootstrap → accept → snapshot → delta)", () => {
  it("keeps the transcript through a launch-flow turn instead of voiding on every append", () => {
    // Fake timers throughout, because "the transcript survived" is only half
    // the claim: the window must also come out of the interleave declaring the
    // skeleton COMPLETE. It does not travel through `state.messages`, so
    // nothing above would notice it staying false - but
    // `chunkedDeliveryIncomplete()` reads it, and the completion watchdog then
    // spends its per-epoch restream budget resnapshotting a healthy stream.
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const cb = harness.callbacks();

      // 1. Bootstrap: the chat exists but the initial message has not been
      //    accepted yet - the subscriber attached mid-`startInitialTurn`.
      cb.onWindowedSnapshot(
        republishSnapshot({
          epoch: 0,
          rowCount: 0,
          indexRevision: null,
          tailMessages: [],
          tailRowIds: [],
        }),
      );
      cb.onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: { epoch: 0, fromOrdinal: 0, entries: [], isFinal: true },
      });

      // 2. The initial message is accepted...
      cb.onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedUserMessage("m-1", 2),
      });
      // ...and its append republish follows: snapshot at the NEW rowCount but
      // the held revision, then the delta for the very same append.
      cb.onWindowedSnapshot(
        republishSnapshot({
          epoch: 0,
          rowCount: 1,
          indexRevision: 0,
          tailMessages: [userMessage("m-1", 2)],
          tailRowIds: ["m-1"],
        }),
      );
      cb.onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 0,
        rowCount: 1,
        indexRevision: 1,
        changes: [
          {
            type: "appended",
            entries: [skeletonEntry("m-1", 0, "user")],
          },
        ],
      });

      const afterUser = harness.handle.store.getState();
      expect(afterUser.transcriptWindow.invalidated).toBe(false);
      expect(harness.resnapshotCount()).toBe(0);
      expect(afterUser.messages.map((message) => message.messageId)).toEqual([
        "m-1",
      ]);
      expect(afterUser.transcriptWindow.skeleton[0]?.rowId).toBe("m-1");
      // The snapshot declared the skeleton short - correctly, at the instant it
      // landed - and this delta is what fills the ordinal it was short by.
      expect(afterUser.transcriptWindow.skeletonComplete).toBe(true);
      expect(afterUser.transcriptWindow.skeletonStreamCoveredThrough).toBe(1);

      // 3. The assistant row lands the same way one broadcast later.
      cb.onWindowedSnapshot(
        republishSnapshot({
          epoch: 0,
          rowCount: 2,
          indexRevision: 1,
          tailMessages: [userMessage("m-1", 2), assistantMessage("a-1", 3)],
          tailRowIds: ["m-1", "a-1"],
        }),
      );
      cb.onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 0,
        rowCount: 2,
        indexRevision: 2,
        changes: [
          {
            type: "appended",
            entries: [skeletonEntry("a-1", 1, "assistant")],
          },
        ],
      });

      const afterAssistant = harness.handle.store.getState();
      expect(afterAssistant.transcriptWindow.invalidated).toBe(false);
      expect(harness.resnapshotCount()).toBe(0);
      expect(harness.rangeRequestCount()).toBe(0);
      expect(
        afterAssistant.messages.map((message) => message.messageId),
      ).toEqual(["m-1", "a-1"]);
      expect(afterAssistant.transcriptWindow.skeleton[0]?.rowId).toBe("m-1");
      expect(afterAssistant.transcriptWindow.skeleton[1]?.rowId).toBe("a-1");
      expect(afterAssistant.transcriptWindow.skeletonComplete).toBe(true);
      expect(afterAssistant.transcriptWindow.skeletonStreamCoveredThrough).toBe(
        2,
      );

      // 4. And the stream goes quiet, as a turn does between tokens. A window
      //    that came out of the interleave still calling its skeleton
      //    incomplete asks for a full resnapshot here - once per idle window,
      //    up to `MAX_WATCHDOG_RESTREAMS_PER_EPOCH` - having lost nothing.
      vi.advanceTimersByTime(STREAM_COMPLETION_TIMEOUT_MS + 1);
      expect(harness.resnapshotCount()).toBe(0);
    } finally {
      harness.handle.dispose();
      vi.useRealTimers();
    }
  });

  it("names the rows it appends to a tail seated without ids", () => {
    // The positional fallback: `tail.rowIds` is optional on the wire, and a
    // host that sends none leaves the tail seated with the empty string at
    // every ordinal (`tailRowIdsFor`). The skeleton stream is what normally
    // backfills those - but a row appended AFTER that stream finished is one
    // no chunk will ever revisit, so the delta is the last authority to reach
    // it. Left unadopted the span keeps `""`, and `transcriptListRows` renders
    // neither the ordinal (no model is named `""`) nor the model (the skeleton
    // now names it) - a row the client holds, drawn nowhere.
    const harness = createHarness();
    try {
      const cb = harness.callbacks();

      cb.onWindowedSnapshot(
        republishSnapshot({
          epoch: 0,
          rowCount: 0,
          indexRevision: null,
          tailMessages: [],
          tailRowIds: undefined,
        }),
      );
      cb.onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        chunk: { epoch: 0, fromOrdinal: 0, entries: [], isFinal: true },
      });
      cb.onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: acceptedUserMessage("m-1", 2),
      });
      cb.onWindowedSnapshot(
        republishSnapshot({
          epoch: 0,
          rowCount: 1,
          indexRevision: 0,
          tailMessages: [userMessage("m-1", 2)],
          tailRowIds: undefined,
        }),
      );
      // Seated positionally, with nothing yet to name it.
      expect(
        harness.handle.store.getState().transcriptWindow.spans[0]?.rowIds,
      ).toEqual([""]);

      cb.onIndexChanged({
        kind: "indexChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        epoch: 0,
        rowCount: 1,
        indexRevision: 1,
        changes: [
          { type: "appended", entries: [skeletonEntry("m-1", 0, "user")] },
        ],
      });

      const state = harness.handle.store.getState();
      expect(state.transcriptWindow.spans[0]?.rowIds).toEqual(["m-1"]);
      // Adopting is not contradicting: the body survives with its identity.
      expect(state.messages.map((message) => message.messageId)).toEqual([
        "m-1",
      ]);
      expect(harness.resnapshotCount()).toBe(0);
    } finally {
      harness.handle.dispose();
    }
  });
});
