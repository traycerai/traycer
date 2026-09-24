import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  buildRowSkeleton,
  transcriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import {
  buildTranscriptRecordLookup,
  sliceTranscriptRange,
  sliceTranscriptTail,
  type TranscriptTailSlice,
} from "@traycer/protocol/persistence/chat-transcript/read-range";
import {
  projectTranscriptRows,
  type TranscriptRowProjectionInput,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { ChatMessage } from "@/components/chat/chat-message";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * # The auto-mode judge notices, end to end through the windowed store
 *
 * The host journals each notice as a `permission.blocked` event and nothing
 * else. Until the transcript projection gave that event a row, the notice
 * reached this store and was drawn nowhere - including the one that tells a
 * user Automatic moved their judge's billing to the conversation's provider.
 *
 * The HOST half here is played by the protocol's own producers - the same
 * `buildRowSkeleton`, `sliceTranscriptTail` and `sliceTranscriptRange` the
 * live host serves a reopened chat from - over one persisted transcript. The
 * CLIENT half is the real store, the real `useRenderedMessages` and the real
 * `transcriptListRows`, which is exactly what the chat tile draws.
 */

const EPIC_ID = "epic-notice";
const CHAT_ID = "chat-notice";
const OWNER_ID = "owner-notice";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const FALLBACK_TEXT =
  "Traycer's judge couldn't run on Traycer inference (out of credits), so it is reviewing commands on Claude Code instead, billed to your account there.";
const UNAVAILABLE_TEXT =
  "Traycer could not resolve an auto-mode judge, so commands are being sent to you for approval. Pick a judge in Settings → Permissions.";
const POLICY_TEXT =
  "This repository's Auto mode rules can add restrictions but not permissions; only its Ask first and Never allow sections were applied.";

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

/** A notice exactly as the host's `emitAutoJudgeNotice` journals it. */
function noticeEvent(input: {
  readonly eventId: string;
  readonly marker: string;
  readonly message: string;
  readonly timestamp: number;
  readonly turnId: string | null;
}): ChatEvent {
  return {
    eventId: input.eventId,
    type: "permission.blocked",
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: input.message,
    turnId: input.turnId,
    messageId: input.turnId === null ? null : "u-1",
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "warning",
    metadata: { autoJudge: input.marker },
  };
}

/** One persisted transcript: two sends, with all three notices between. */
const PERSISTED: TranscriptRowProjectionInput = {
  messages: [userMessage("u-1", 1000), userMessage("u-2", 5000)],
  events: [
    noticeEvent({
      eventId: "e-fallback",
      marker: "fallback",
      message: FALLBACK_TEXT,
      timestamp: 2000,
      turnId: "turn-1",
    }),
    noticeEvent({
      eventId: "e-unavailable",
      marker: "unavailable",
      message: UNAVAILABLE_TEXT,
      timestamp: 3000,
      turnId: null,
    }),
    noticeEvent({
      eventId: "e-policy",
      marker: "policy-not-applied",
      message: POLICY_TEXT,
      timestamp: 4000,
      turnId: "turn-1",
    }),
  ],
  activeTurnId: null,
  chatId: CHAT_ID,
};

const EXPECTED_NOTICES = [
  { ordinal: 1, marker: "fallback", message: FALLBACK_TEXT },
  { ordinal: 2, marker: "unavailable", message: UNAVAILABLE_TEXT },
  { ordinal: 3, marker: "policy-not-applied", message: POLICY_TEXT },
];

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-notice",
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
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: (request) => {
          rangeRequests.push(request);
        },
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

const EMPTY_TAIL = (rowCount: number): TranscriptTailSlice => ({
  fromOrdinal: rowCount,
  rowIds: [],
  incompleteRowIds: [],
  messages: [],
  events: [],
  rowContext: {},
});

function snapshot(input: {
  readonly rowCount: number;
  readonly tail: TranscriptTailSlice;
}): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  const derived: ChatTranscriptDerived = {
    latestAssistantUsage: null,
    pinnedTodo: null,
    pinnedTaskTodoItems: [],
    latestForkableAssistantMessageId: null,
    restorableSetupInterruption: null,
    interviewAnswerability: [],
    latestAssistantAuthFailureTurnKey: null,
    setupCardWindows: [],
  };
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
        hostId: "host-notice",
        title: "Judge notices",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
        kind: "conversation",
        evolutionTurnsSinceReview: null,
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
      transcriptEpoch: 1,
      rowCount: input.rowCount,
      indexRevision: null,
      tail: {
        fromOrdinal: input.tail.fromOrdinal,
        rowIds: [...input.tail.rowIds],
        incompleteRowIds: [...input.tail.incompleteRowIds],
        messages: [...input.tail.messages],
        events: [...input.tail.events],
        rowContext: { ...input.tail.rowContext },
      },
      derived,
    },
  };
}

/** The whole skeleton in one final chunk, as the host builds it. */
function skeletonChunk(): Parameters<
  ChatStreamCallbacks["onSkeletonChunk"]
>[0] {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: 1,
      fromOrdinal: 0,
      entries: [
        ...buildRowSkeleton(PERSISTED, transcriptPreviewProjection, null),
      ],
      isFinal: true,
    },
  };
}

const DISPLAY_CONTEXT: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksPreview: () => "",
};

/** What the chat tile draws from this store right now, the way it draws it. */
function drawnRows(handle: ChatSessionStoreHandle) {
  const state = handle.store.getState();
  const { result } = renderHook(() =>
    useRenderedMessages(
      {
        messages: state.messages,
        events: state.events,
        rowContext: state.transcriptRowContext,
        setupCardWindows: [],
        pendingUserMessages: [],
        withdrawnMessageId: null,
        liveAssistantMessage: null,
        activeTurn: null,
        runStatus: "idle",
        epicId: EPIC_ID,
        ownerId: CHAT_ID,
        ownerKind: "chat",
        viewTabId: "tab-notice",
      },
      DISPLAY_CONTEXT,
    ),
  );
  return transcriptListRows({
    window: state.transcriptWindow,
    rendered: result.current,
  });
}

function drawnNotices(handle: ChatSessionStoreHandle): Array<{
  readonly ordinal: number | null;
  readonly marker: string;
  readonly message: string;
  readonly model: ChatMessageModel;
}> {
  return drawnRows(handle).flatMap((row) => {
    if (row.kind !== "hydrated") return [];
    const segment = row.model.segments.at(0);
    if (segment === undefined || segment.kind !== "auto-judge-notice") {
      return [];
    }
    return [
      {
        ordinal: row.ordinal,
        marker: segment.marker,
        message: segment.message,
        model: row.model,
      },
    ];
  });
}

function renderRow(model: ChatMessageModel): void {
  render(
    <ChatMessage
      message={model}
      actions={null}
      backgroundToolBlockIds={new Set()}
      nextStepActions={null}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("auto-mode judge notices in the windowed transcript", () => {
  it("reopen: a snapshot tail the host slices from the persisted transcript draws every notice at its ordinal, with the host's text", () => {
    const rows = projectTranscriptRows(PERSISTED);
    const tail = sliceTranscriptTail(
      rows,
      buildTranscriptRecordLookup(PERSISTED.messages, PERSISTED.events),
      1_000_000,
      null,
    );
    // The whole chat fits, so the tail IS the transcript.
    expect(tail.fromOrdinal).toBe(0);

    const harness = createHarness();
    try {
      harness
        .callbacks()
        .onWindowedSnapshot(snapshot({ rowCount: rows.length, tail }));
      harness.callbacks().onSkeletonChunk(skeletonChunk());

      const drawn = drawnNotices(harness.handle);
      expect(
        drawn.map(({ ordinal, marker, message }) => ({
          ordinal,
          marker,
          message,
        })),
      ).toEqual(EXPECTED_NOTICES);
      expect(harness.rangeRequests).toHaveLength(0);

      const fallback = drawn.find((notice) => notice.marker === "fallback");
      if (fallback === undefined) throw new Error("fallback notice not drawn");
      renderRow(fallback.model);
      const note = screen.getByRole("note");
      expect(note.textContent).toBe(FALLBACK_TEXT);
      expect(note.getAttribute("data-auto-judge-notice")).toBe("fallback");
    } finally {
      harness.handle.dispose();
    }
  });

  it("reopen: notices outside the tail hydrate through loadRange, answered by the host's range slicer", () => {
    const rows = projectTranscriptRows(PERSISTED);
    const lookup = buildTranscriptRecordLookup(
      PERSISTED.messages,
      PERSISTED.events,
    );
    const harness = createHarness();
    try {
      harness
        .callbacks()
        .onWindowedSnapshot(
          snapshot({ rowCount: rows.length, tail: EMPTY_TAIL(rows.length) }),
        );
      harness.callbacks().onSkeletonChunk(skeletonChunk());
      // Nothing drawn yet: every ordinal is a placeholder.
      expect(drawnNotices(harness.handle)).toEqual([]);

      const request = harness.rangeRequests.at(-1);
      if (request === undefined) throw new Error("expected a loadRange");
      const slice = sliceTranscriptRange(
        rows,
        lookup,
        {
          fromOrdinal: request.fromOrdinal,
          toOrdinal: request.toOrdinal,
          maxBytes: request.maxBytes,
        },
        null,
      );
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: request.requestId,
          epoch: request.epoch,
          fromOrdinal: slice.fromOrdinal,
          rowIds: [...slice.rowIds],
          incompleteRowIds: [...slice.incompleteRowIds],
          messages: [...slice.messages],
          events: [...slice.events],
          rowContext: { ...slice.rowContext },
          reachedStart: slice.reachedStart,
          reachedEnd: slice.reachedEnd,
        },
      });

      const drawn = drawnNotices(harness.handle);
      expect(
        drawn.map(({ ordinal, marker, message }) => ({
          ordinal,
          marker,
          message,
        })),
      ).toEqual(EXPECTED_NOTICES);

      for (const notice of drawn) renderRow(notice.model);
      expect(
        screen.getAllByRole("note").map((note) => note.textContent),
      ).toEqual([FALLBACK_TEXT, UNAVAILABLE_TEXT, POLICY_TEXT]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("live: a notice appended to an open chat is drawn the moment it arrives", () => {
    const opened: TranscriptRowProjectionInput = {
      messages: [userMessage("u-1", 1000)],
      events: [],
      activeTurnId: null,
      chatId: CHAT_ID,
    };
    const rows = projectTranscriptRows(opened);
    const harness = createHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: rows.length,
          tail: sliceTranscriptTail(
            rows,
            buildTranscriptRecordLookup(opened.messages, opened.events),
            1_000_000,
            null,
          ),
        }),
      );
      expect(drawnNotices(harness.handle)).toEqual([]);

      harness.callbacks().onEventAppended({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: noticeEvent({
          eventId: "e-live-fallback",
          marker: "fallback",
          message: FALLBACK_TEXT,
          timestamp: 2000,
          turnId: "turn-1",
        }),
      });

      const drawn = drawnNotices(harness.handle);
      expect(drawn.map(({ marker, message }) => ({ marker, message }))).toEqual(
        [{ marker: "fallback", message: FALLBACK_TEXT }],
      );
      const live = drawn.at(0);
      if (live === undefined) throw new Error("live notice not drawn");
      renderRow(live.model);
      expect(screen.getByRole("note").textContent).toBe(FALLBACK_TEXT);
    } finally {
      harness.handle.dispose();
    }
  });
});
