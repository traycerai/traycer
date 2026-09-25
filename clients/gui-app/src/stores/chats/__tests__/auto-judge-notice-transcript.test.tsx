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
import { buildChatFindRows } from "@/components/chat/chat-find-projection";
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
 * The host no longer writes this notice at all (`AutoJudgeService` escalates
 * through `unavailable(...)` only; policy facts are WARN log lines). But a
 * chat opened before that change can still have `permission.blocked` events
 * with `metadata.autoJudge` on disk, and `autoJudgeNoticeRowSource` /
 * `AUTO_JUDGE_NOTICE_MARKERS` (protocol) keep giving them a row so the
 * ordinals around them do not renumber - a window or an anchor computed
 * against the old row count must still land on the same message.
 *
 * So this suite now proves two things about a LEGACY row: it is still
 * PROJECTED at its ordinal (`rendered-messages.ts` is unchanged), and
 * rendering it paints nothing at all - `chat-message.tsx`'s
 * `auto-judge-notice` case returns `null` from the special-segment renderer,
 * and (unlike the other special segments, which have no sender/body but no
 * `system` role or timestamp either) the row's `system` role and timestamp do
 * not fall through to the ordinary sender overline - and contributes no find
 * units (`chat-find-projection.ts`'s `segmentSearchText` returns `[]` for it).
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

/**
 * A notice exactly as a pre-removal host used to journal it - the shape a
 * `permission.blocked` event with an `autoJudge` marker still has when it is
 * read off disk from a chat that predates the change.
 */
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

/**
 * The legacy notice rows the store PROJECTS - which still happens
 * unconditionally, since `rendered-messages.ts` and the protocol's row
 * ordinals are unchanged. Named `projected`, not `drawn`: whether one of
 * these actually paints anything is exactly what the tests below check
 * separately, by rendering `model` and asserting nothing appears.
 */
function projectedNotices(handle: ChatSessionStoreHandle): Array<{
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

function renderRow(model: ChatMessageModel): HTMLElement {
  const { container } = render(
    <ChatMessage
      message={model}
      actions={null}
      backgroundToolBlockIds={new Set()}
      nextStepActions={null}
    />,
  );
  return container;
}

afterEach(() => {
  cleanup();
});

describe("auto-mode judge notices in the windowed transcript", () => {
  it("reopen: a snapshot tail the host slices from the persisted transcript still projects every legacy notice at its ordinal, but paints and indexes nothing", () => {
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

      const drawn = projectedNotices(harness.handle);
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
      const container = renderRow(fallback.model);
      // But rendering it paints nothing: `chat-message.tsx`'s
      // `auto-judge-notice` case returns `null`, and the row's `system` role
      // and timestamp do not fall through to the sender overline either.
      expect(container.firstChild).toBeNull();
      expect(screen.queryByRole("note")).toBeNull();
      expect(screen.queryByText(FALLBACK_TEXT)).toBeNull();
      expect(screen.queryByText(/system/i)).toBeNull();
      // And it contributes no find units either.
      expect(
        buildChatFindRows([fallback.model], "tile-notice", new Set())[0]?.units,
      ).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("reopen: legacy notices outside the tail still hydrate through loadRange, answered by the host's range slicer, but paint nothing", () => {
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
      expect(projectedNotices(harness.handle)).toEqual([]);

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

      const drawn = projectedNotices(harness.handle);
      expect(
        drawn.map(({ ordinal, marker, message }) => ({
          ordinal,
          marker,
          message,
        })),
      ).toEqual(EXPECTED_NOTICES);

      const containers = drawn.map((notice) => renderRow(notice.model));
      // Nothing paints for any of the three, whichever sender wrote it - not
      // even the row's own `system` role and timestamp overline.
      expect(screen.queryAllByRole("note")).toHaveLength(0);
      expect(screen.queryByText(/system/i)).toBeNull();
      for (const container of containers) {
        expect(container.firstChild).toBeNull();
      }
      for (const notice of drawn) {
        expect(screen.queryByText(notice.message)).toBeNull();
        expect(
          buildChatFindRows([notice.model], "tile-notice", new Set())[0]?.units,
        ).toEqual([]);
      }
    } finally {
      harness.handle.dispose();
    }
  });

  it("live: a legacy-shaped notice event appended to an open chat is projected the moment it arrives, but paints nothing", () => {
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
      expect(projectedNotices(harness.handle)).toEqual([]);

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

      const drawn = projectedNotices(harness.handle);
      expect(drawn.map(({ marker, message }) => ({ marker, message }))).toEqual(
        [{ marker: "fallback", message: FALLBACK_TEXT }],
      );
      const live = drawn.at(0);
      if (live === undefined) throw new Error("live notice not drawn");
      const container = renderRow(live.model);
      // Still paints nothing, exactly like a rehydrated legacy row - the
      // row's `system` role and timestamp don't fall through either.
      expect(container.firstChild).toBeNull();
      expect(screen.queryByRole("note")).toBeNull();
      expect(screen.queryByText(FALLBACK_TEXT)).toBeNull();
      expect(screen.queryByText(/system/i)).toBeNull();
      expect(
        buildChatFindRows([live.model], "tile-notice", new Set())[0]?.units,
      ).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
});
