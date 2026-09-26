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
  autoJudgeNoticeRowId,
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
import { withholdUnpaintedRows } from "@/components/chat/chat-special-segment";
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
import {
  transcriptListRows,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * # The auto-mode judge notices, end to end through the windowed store
 *
 * The host no longer writes this notice at all (`AutoJudgeService` escalates
 * through `unavailable(...)` only; policy facts are WARN log lines). But a
 * chat opened before that change can still have `permission.blocked` events
 * with `metadata.autoJudge` on disk, and an older host still appends them live
 * to an open chat. `autoJudgeNoticeRowSource` / `AUTO_JUDGE_NOTICE_MARKERS`
 * (protocol) keep giving them a row so the ordinals around them do not
 * renumber - a window or an anchor computed against the old row count must
 * still land on the same message.
 *
 * So this suite proves three things about a LEGACY row:
 *
 * - The renderer still ENUMERATES it (`useRenderedMessages`), because that
 *   list is held to the host's projection row for row.
 * - The LIST the tile draws holds nothing for it - no hydrated row and no
 *   placeholder - because the tile withholds it (`withholdUnpaintedRows`) and
 *   `transcriptListRows` then omits its ordinal. An empty `ChatMessage` would
 *   not be enough: the timeline frames every row it draws, so a row that
 *   renders `null` still leaves a blank band.
 * - That holds on every path a row reaches the client by: a reopened tail, a
 *   `loadRange`, and a live append, with and without the append's republished
 *   snapshot.
 *
 * The HOST half is played by the protocol's own producers - the same
 * `buildRowSkeleton`, `sliceTranscriptTail` and `sliceTranscriptRange` the
 * live host serves a chat from. The CLIENT half is the real store, the real
 * `useRenderedMessages` and the real `transcriptListRows`, joined the way the
 * chat tile joins them.
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
 * A notice exactly as a pre-removal host journals it - the shape a
 * `permission.blocked` event with an `autoJudge` marker has, read off disk
 * from a chat that predates the change or appended live by an older host.
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

/** The notice rows the host numbers in {@link PERSISTED}, by ordinal. */
const PERSISTED_NOTICE_ROW_IDS = [
  autoJudgeNoticeRowId("e-fallback"),
  autoJudgeNoticeRowId("e-unavailable"),
  autoJudgeNoticeRowId("e-policy"),
];

/** What the tile draws for {@link PERSISTED}: the two sends, and nothing else. */
const PERSISTED_DRAWN = [
  { kind: "hydrated", key: "u-1", ordinal: 0 },
  { kind: "hydrated", key: "u-2", ordinal: 4 },
];

/** A chat open on one send, before the live notice arrives. */
const OPENED: TranscriptRowProjectionInput = {
  messages: [userMessage("u-1", 1000)],
  events: [],
  activeTurnId: null,
  chatId: CHAT_ID,
};

const LIVE_NOTICE = noticeEvent({
  eventId: "e-live-fallback",
  marker: "fallback",
  message: FALLBACK_TEXT,
  timestamp: 2000,
  turnId: "turn-1",
});

/** The same chat once the live notice is on the host's disk. */
const AFTER_LIVE_NOTICE: TranscriptRowProjectionInput = {
  ...OPENED,
  events: [LIVE_NOTICE],
};

const OPENED_DRAWN = [{ kind: "hydrated", key: "u-1", ordinal: 0 }];

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

/** The whole transcript as one tail slice, as a host serves a short chat. */
function wholeTail(input: TranscriptRowProjectionInput): TranscriptTailSlice {
  return sliceTranscriptTail(
    projectTranscriptRows(input),
    buildTranscriptRecordLookup(input.messages, input.events),
    1_000_000,
    null,
  );
}

function snapshot(input: {
  readonly rowCount: number;
  readonly tail: TranscriptTailSlice;
  readonly indexRevision: number | null;
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
      indexRevision: input.indexRevision,
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

/** The whole skeleton of `input` in one final chunk, as the host builds it. */
function skeletonChunk(
  input: TranscriptRowProjectionInput,
): Parameters<ChatStreamCallbacks["onSkeletonChunk"]>[0] {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: 1,
      fromOrdinal: 0,
      entries: [...buildRowSkeleton(input, transcriptPreviewProjection, null)],
      isFinal: true,
    },
  };
}

/** The shared frame an append broadcast leads with. */
function eventAppended(
  event: ChatEvent,
): Parameters<ChatStreamCallbacks["onEventAppended"]>[0] {
  return {
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    event,
  };
}

/**
 * The `indexChanged` delta for a one-row append that took the transcript from
 * `before` to `after`: the new row's skeleton entry, as the host builds it.
 */
function appendedDelta(input: {
  readonly after: TranscriptRowProjectionInput;
  readonly indexRevision: number;
}): Parameters<ChatStreamCallbacks["onIndexChanged"]>[0] {
  const entries = buildRowSkeleton(
    input.after,
    transcriptPreviewProjection,
    null,
  );
  const appended = entries.at(-1);
  if (appended === undefined) throw new Error("expected an appended row");
  return {
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    epoch: 1,
    rowCount: entries.length,
    indexRevision: input.indexRevision,
    changes: [{ type: "appended", entries: [appended] }],
  };
}

/** Answer the harness's latest `loadRange` from `input`, as the host would. */
function answerLatestRange(
  harness: Harness,
  input: TranscriptRowProjectionInput,
): ChatLoadRangeRequest {
  const request = harness.rangeRequests.at(-1);
  if (request === undefined) throw new Error("expected a loadRange");
  const slice = sliceTranscriptRange(
    projectTranscriptRows(input),
    buildTranscriptRecordLookup(input.messages, input.events),
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
  return request;
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

/** The renderer's enumeration: every row the host numbers, notices included. */
function renderedRows(
  handle: ChatSessionStoreHandle,
): ReadonlyArray<ChatMessageModel> {
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
  return result.current;
}

/**
 * What the chat tile draws from this store right now, the way it draws it:
 * `useRenderedMessages`, then the tile's `withholdUnpaintedRows`, then
 * `transcriptListRows` (`chat-tile.tsx` → `chat-messages.tsx`).
 */
function drawnRows(
  handle: ChatSessionStoreHandle,
): ReadonlyArray<TranscriptListRow> {
  return transcriptListRows({
    window: handle.store.getState().transcriptWindow,
    rendered: withholdUnpaintedRows(renderedRows(handle)),
  });
}

/** The drawn list reduced to what a reader could tell apart. */
function drawnSummary(handle: ChatSessionStoreHandle): Array<{
  readonly kind: TranscriptListRow["kind"];
  readonly key: string;
  readonly ordinal: number | null;
}> {
  return drawnRows(handle).map((row) => ({
    kind: row.kind,
    key: row.key,
    ordinal: row.ordinal,
  }));
}

/** The notice rows the renderer enumerates (before the tile withholds them). */
function enumeratedNotices(handle: ChatSessionStoreHandle): Array<{
  readonly id: string;
  readonly marker: string;
  readonly message: string;
  readonly model: ChatMessageModel;
}> {
  return renderedRows(handle).flatMap((model) => {
    const segment = model.segments.at(0);
    if (segment === undefined || segment.kind !== "auto-judge-notice") {
      return [];
    }
    return [
      {
        id: model.id,
        marker: segment.marker,
        message: segment.message,
        model,
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
  it("reopen: a snapshot tail holding every legacy notice draws only the sends, and the notices keep their ordinals", () => {
    const rows = projectTranscriptRows(PERSISTED);
    const tail = wholeTail(PERSISTED);
    // The whole chat fits, so the tail IS the transcript.
    expect(tail.fromOrdinal).toBe(0);

    const harness = createHarness();
    try {
      harness
        .callbacks()
        .onWindowedSnapshot(
          snapshot({ rowCount: rows.length, tail, indexRevision: null }),
        );
      harness.callbacks().onSkeletonChunk(skeletonChunk(PERSISTED));

      // The host still numbers the three notices at ordinals 1-3...
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.rowCount).toBe(5);
      expect(window.skeleton.slice(1, 4).map((entry) => entry?.rowId)).toEqual(
        PERSISTED_NOTICE_ROW_IDS,
      );
      // ...and the renderer still enumerates them, in the host's order.
      expect(
        enumeratedNotices(harness.handle).map(({ id, marker, message }) => ({
          id,
          marker,
          message,
        })),
      ).toEqual([
        {
          id: PERSISTED_NOTICE_ROW_IDS[0],
          marker: "fallback",
          message: FALLBACK_TEXT,
        },
        {
          id: PERSISTED_NOTICE_ROW_IDS[1],
          marker: "unavailable",
          message: UNAVAILABLE_TEXT,
        },
        {
          id: PERSISTED_NOTICE_ROW_IDS[2],
          marker: "policy-not-applied",
          message: POLICY_TEXT,
        },
      ]);

      // But the list the tile draws holds nothing at 1-3: no hydrated row, no
      // placeholder, and the sends keep the ordinals the host gave them.
      expect(drawnSummary(harness.handle)).toEqual(PERSISTED_DRAWN);
      expect(harness.rangeRequests).toHaveLength(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("reopen: legacy notices outside the tail hydrate through loadRange and then draw nothing, not even a placeholder", () => {
    const rows = projectTranscriptRows(PERSISTED);
    const harness = createHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: rows.length,
          tail: EMPTY_TAIL(rows.length),
          indexRevision: null,
        }),
      );
      harness.callbacks().onSkeletonChunk(skeletonChunk(PERSISTED));
      // Nothing hydrated yet: every ordinal is a placeholder, the notices'
      // included, which is what makes the viewport ask for them.
      expect(drawnSummary(harness.handle).map((row) => row.kind)).toEqual([
        "placeholder",
        "placeholder",
        "placeholder",
        "placeholder",
        "placeholder",
      ]);

      answerLatestRange(harness, PERSISTED);

      // The range delivered the notices, the renderer enumerates them...
      expect(enumeratedNotices(harness.handle).map(({ id }) => id)).toEqual(
        PERSISTED_NOTICE_ROW_IDS,
      );
      // ...and the placeholders that held their ordinals are gone rather than
      // replaced by an empty row.
      expect(drawnSummary(harness.handle)).toEqual(PERSISTED_DRAWN);
    } finally {
      harness.handle.dispose();
    }
  });

  it("live: an older host's appended notice draws nothing at any step of its broadcast (shared frame, republished snapshot, delta)", () => {
    const harness = createHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: projectTranscriptRows(OPENED).length,
          tail: wholeTail(OPENED),
          indexRevision: 0,
        }),
      );
      harness.callbacks().onSkeletonChunk(skeletonChunk(OPENED));
      expect(drawnSummary(harness.handle)).toEqual(OPENED_DRAWN);

      // The host's append broadcast, in its real order: the shared frame...
      harness.callbacks().onEventAppended(eventAppended(LIVE_NOTICE));
      // (enumerated, and still withheld rather than appended to the tail)
      expect(enumeratedNotices(harness.handle).map(({ id }) => id)).toEqual([
        autoJudgeNoticeRowId(LIVE_NOTICE.eventId),
      ]);
      expect(drawnSummary(harness.handle)).toEqual(OPENED_DRAWN);

      // ...then the bounded snapshot at the post-append `rowCount` and the
      // held revision, whose tail carries the new row...
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: projectTranscriptRows(AFTER_LIVE_NOTICE).length,
          tail: wholeTail(AFTER_LIVE_NOTICE),
          indexRevision: 0,
        }),
      );
      expect(drawnSummary(harness.handle)).toEqual(OPENED_DRAWN);

      // ...then the delta naming it.
      harness
        .callbacks()
        .onIndexChanged(
          appendedDelta({ after: AFTER_LIVE_NOTICE, indexRevision: 1 }),
        );
      const window = harness.handle.store.getState().transcriptWindow;
      expect(window.invalidated).toBe(false);
      expect(window.rowCount).toBe(2);
      expect(window.skeleton[1]?.rowId).toBe(
        autoJudgeNoticeRowId(LIVE_NOTICE.eventId),
      );
      // Ordinal 1 is the notice's and nothing is drawn for it.
      expect(drawnSummary(harness.handle)).toEqual(OPENED_DRAWN);
      expect(harness.rangeRequests).toHaveLength(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("live: when the republished snapshot is lost, the notice's placeholder asks for its row and then draws nothing", () => {
    const harness = createHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: projectTranscriptRows(OPENED).length,
          tail: wholeTail(OPENED),
          indexRevision: 0,
        }),
      );
      harness.callbacks().onSkeletonChunk(skeletonChunk(OPENED));

      // The shared frame and the delta arrive; the snapshot between them was
      // dropped by a flaky write, which the pump tolerates.
      harness.callbacks().onEventAppended(eventAppended(LIVE_NOTICE));
      harness
        .callbacks()
        .onIndexChanged(
          appendedDelta({ after: AFTER_LIVE_NOTICE, indexRevision: 1 }),
        );

      // No span holds the new tail row yet, so it stands as a placeholder -
      // and that is transient, not permanent: the eager-tail plan asks for it.
      expect(drawnSummary(harness.handle)).toEqual([
        ...OPENED_DRAWN,
        {
          kind: "placeholder",
          key: autoJudgeNoticeRowId(LIVE_NOTICE.eventId),
          ordinal: 1,
        },
      ]);
      // `ChatLoadRangeRequest` bounds are inclusive at both ends.
      const request = answerLatestRange(harness, AFTER_LIVE_NOTICE);
      expect(request.fromOrdinal).toBeLessThanOrEqual(1);
      expect(request.toOrdinal).toBeGreaterThanOrEqual(1);

      // The range holds the row, the tile withholds it, and the placeholder
      // leaves with nothing in its place.
      expect(drawnSummary(harness.handle)).toEqual(OPENED_DRAWN);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a notice model that reaches a ChatMessage anyway paints nothing - no note, no text, no System overline - and indexes nothing for find", () => {
    const harness = createHarness();
    try {
      harness.callbacks().onWindowedSnapshot(
        snapshot({
          rowCount: projectTranscriptRows(PERSISTED).length,
          tail: wholeTail(PERSISTED),
          indexRevision: null,
        }),
      );
      harness.callbacks().onSkeletonChunk(skeletonChunk(PERSISTED));
      const notices = enumeratedNotices(harness.handle);
      expect(notices).toHaveLength(3);

      const containers = notices.map((notice) => renderRow(notice.model));
      for (const container of containers) {
        expect(container.firstChild).toBeNull();
      }
      expect(screen.queryAllByRole("note")).toHaveLength(0);
      expect(screen.queryByText(/system/i)).toBeNull();
      for (const notice of notices) {
        expect(screen.queryByText(notice.message)).toBeNull();
        expect(
          buildChatFindRows([notice.model], "tile-notice", new Set())[0]?.units,
        ).toEqual([]);
      }
    } finally {
      harness.handle.dispose();
    }
  });
});
