/**
 * Chat find's CANDIDATE/CONFIRM contract (F14): an index hit on a message that
 * is not fully loaded is only a candidate - never counted in `total`, never
 * the active stop - until stepping onto it reads the row (`requestIndexRead`,
 * no viewport move) and the client scan either confirms it (it becomes a real
 * stop) or drops it (the walk continues). The census rows are index text the
 * transcript does not paint; each is read and dropped, never advertised.
 *
 * The harness (renderFind, transcriptOf, userSpec, assistantRecord, fakeIndex,
 * hostFixture, mountRow, installMockHighlights, installFrameQueue/flushFrames,
 * EXCLUSION_TAIL) is adapted from `chat-find-index-backed.test.tsx`; see that
 * file's header for its description.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockMethodHandler,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import {
  type ChatSearchMessageHit,
  type ChatSearchRequest,
  type ChatSearchResponse,
  type ChatSearchTier,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  buildChatFindRows,
  chatFindCoverageMessage,
  chatFindSegmentUnitId,
  type ChatFindAdapter,
} from "@/components/chat/chat-find";
import { chatFindTranscriptPlacement } from "@/components/chat/chat-find-index";
import type { ChatFindIndexRead } from "@/components/chat/chat-find-index";
import { useChatFindIndexFeed } from "@/hooks/chats/use-chat-find-index-feed";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
import { TranscriptQueuePauseReasonSupportContext } from "@/components/chat/use-transcript-queue-pause-reason-support";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  ChatFindForceStoreContext,
  ChatFindForceTileInstanceIdContext,
  createChatFindForceStore,
} from "@/stores/chats/chat-find-force-store-context";
import {
  appendLiveRecords,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  unhydratedRowCount,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
  ProviderNoticeSegment,
} from "@/stores/composer/chat-store";
import type { TileFindAdapter } from "@/stores/tile-find";
import { makeMessageAt } from "./chat-message-fixtures";

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: mockLocalHostEntry.hostId,
    requestContextUserId: "user-1",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));

const TILE_INSTANCE_ID = "find-index-confirm-tile";
const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const EMPTY_PROMOTED: ReadonlySet<string> = new Set<string>();
const EXCLUSION_TAIL =
  "older reasoning, subagent and tool output are not indexed.";

// ---------------------------------------------------------------------------
// The caveat copy (`chatFindIndexCoverageMessage`,
// `CHAT_FIND_INDEX_CHECKING_MESSAGE`), spelled out so a copy change is seen.
const CAVEAT_MAY_MATCH_ONE = `1 older message may match; ${EXCLUSION_TAIL}`;
const CAVEAT_MAY_MATCH_MANY = (count: number): string =>
  `${count} older messages may match; ${EXCLUSION_TAIL}`;
const CAVEAT_CHECKING = "Checking an older message…";

// ---------------------------------------------------------------------------
// Records, rendered rows and the window that holds them (copied verbatim from
// chat-find-index-backed.test.tsx).

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function userRecord(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function assistantRecord(
  messageId: string,
  turnId: string,
  timestamp: number,
): Message {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function userRow(id: string, content: string, createdAt: number) {
  return {
    ...makeMessageAt(0, "user", createdAt),
    id,
    content,
    persistentMessageId: id,
  } satisfies ChatMessageModel;
}

/** An assistant row with an arbitrary segment list (not just one "text" segment). */
function assistantSegmentsRow(input: {
  readonly rowId: string;
  readonly persistentMessageId: string;
  readonly createdAt: number;
  readonly segments: ReadonlyArray<MessageSegment>;
  readonly manualRungAnchorId?: string;
  readonly routingSettledNoticeId?: string;
}): ChatMessageModel {
  return {
    ...makeMessageAt(0, "assistant", input.createdAt),
    id: input.rowId,
    persistentMessageId: input.persistentMessageId,
    runState: null,
    segments: input.segments,
    ...(input.manualRungAnchorId === undefined
      ? {}
      : { manualRungAnchorId: input.manualRungAnchorId }),
    ...(input.routingSettledNoticeId === undefined
      ? {}
      : { routingSettledNoticeId: input.routingSettledNoticeId }),
  };
}

interface RowSpec {
  readonly rowId: string;
  readonly createdAt: number;
  readonly role: "user" | "assistant";
  readonly records: ReadonlyArray<Message>;
  readonly model: ChatMessageModel | null;
}

interface TranscriptState {
  readonly window: TranscriptWindow;
  readonly messages: ReadonlyArray<ChatMessageModel>;
}

function transcriptOf(
  rows: ReadonlyArray<RowSpec>,
  live: {
    readonly records: ReadonlyArray<Message>;
    readonly models: ReadonlyArray<ChatMessageModel>;
  } | null,
): TranscriptState {
  let window = applyWindowedSnapshot(
    emptyTranscriptWindow(),
    {
      epoch: 1,
      rowCount: rows.length,
      indexRevision: null,
      tail: { fromOrdinal: rows.length, messages: [], events: [] },
    },
    null,
    null,
  );
  window = applySkeletonChunk(window, {
    epoch: 1,
    fromOrdinal: 0,
    entries: rows.map((row) => ({
      rowId: row.rowId,
      createdAt: row.createdAt,
      role: row.role,
      byteLength: 128,
      bodyDigest: `d-${row.rowId}`,
    })),
    isFinal: true,
  });
  let ordinal = 0;
  while (ordinal < rows.length) {
    if (rows[ordinal].model === null) {
      ordinal += 1;
      continue;
    }
    const from = ordinal;
    while (ordinal < rows.length && rows[ordinal].model !== null) ordinal += 1;
    const run = rows.slice(from, ordinal);
    const records = new Map<string, Message>();
    for (const row of run) {
      for (const record of row.records) records.set(record.messageId, record);
    }
    window = applyRangeResponse(
      window,
      {
        requestId: `req-${from}`,
        epoch: 1,
        fromOrdinal: from,
        rowIds: run.map((row) => row.rowId),
        incompleteRowIds: [],
        messages: [...records.values()],
        events: [],
        rowContext: {},
        reachedStart: from === 0,
        reachedEnd: ordinal === rows.length,
      },
      null,
      null,
    );
  }
  if (live !== null) {
    window = appendLiveRecords(window, {
      messages: [...live.records],
      events: [],
    });
  }
  return {
    window,
    messages: [
      ...rows.flatMap((row) => (row.model === null ? [] : [row.model])),
      ...(live?.models ?? []),
    ],
  };
}

function userSpec(
  id: string,
  createdAt: number,
  content: string,
  hydrated: boolean,
): RowSpec {
  return {
    rowId: id,
    createdAt,
    role: "user",
    records: [userRecord(id, createdAt)],
    model: hydrated ? userRow(id, content, createdAt) : null,
  };
}

// ---------------------------------------------------------------------------
// The host (copied verbatim from chat-find-index-backed.test.tsx).

interface FakeDoc {
  readonly messageId: string;
  readonly tier: ChatSearchTier;
  readonly createdAt: number;
  readonly text: string;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function fakeIndex(
  docs: ReadonlyArray<FakeDoc>,
): MockMethodHandler<HostRpcRegistry, "chat.search"> {
  return (params: ChatSearchRequest): ChatSearchResponse => {
    expect(params.scope).toEqual({
      kind: "chat",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
    });
    expect(params.mode).toBe("substring");
    const needle = asciiLower(params.query.trim());
    const tiers = params.tiers ?? ["user", "assistant", "notice"];
    const to = params.dateRange?.to ?? null;
    const matching = docs
      .filter(
        (doc) =>
          tiers.includes(doc.tier) &&
          (to === null || doc.createdAt <= to) &&
          asciiLower(doc.text).includes(needle),
      )
      .toSorted((left, right) => right.createdAt - left.createdAt);
    const offset =
      params.messageCursor === null ? 0 : Number(params.messageCursor);
    const page = matching.slice(offset, offset + params.messageLimit);
    const hitOf = (doc: FakeDoc): ChatSearchMessageHit => ({
      messageId: doc.messageId,
      tier: doc.tier,
      createdAt: doc.createdAt,
      interAgent: false,
      truncated: false,
      snippet: { text: doc.text, highlights: [] },
    });
    return {
      chatMatches: [],
      chatNextCursor: null,
      messageMatches:
        matching.length === 0
          ? []
          : [
              {
                epicId: EPIC_ID,
                ownerUserId: "user-1",
                chatId: CHAT_ID,
                title: "chat",
                lifecycleState: "active",
                updatedAt: 1,
                matchCount: matching.length,
                best: hitOf(matching[0]),
                messages: page.map(hitOf),
              },
            ],
      messageNextCursor:
        offset + params.messageLimit < matching.length
          ? String(offset + params.messageLimit)
          : null,
      indexState: "partial",
    };
  };
}

function hostFixture(
  handler: MockMethodHandler<HostRpcRegistry, "chat.search">,
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestCount += 1;
      return `req-${requestCount}`;
    },
    handlers: { "chat.search": handler },
  });
  const hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  hostClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    client: hostClient.createRequester(mockLocalHostEntry),
    messenger,
    queryClient,
  };
}

let requestCount = 0;

// ---------------------------------------------------------------------------
// The tile: `ChatMessages`' find wiring over the window - adapted to add the
// two NEW seams (requestIndexRead, the queue-pause-support Provider).

interface ControllerHandle {
  readonly onTranscriptLandingSettled: (
    rowMessageId: string,
    outcome: "landed" | "exhausted" | "cancelled",
  ) => void;
  // The read for a candidate could not be placed (locate answered
  // `found: false`, errored, or ran past its TTL).
  readonly onIndexReadFailed: (messageId: string) => void;
}

function renderFind(input: {
  readonly initial: TranscriptState;
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly scroller: HTMLElement;
  readonly requestIndexJump: Mock<(messageId: string) => void>;
  readonly requestIndexRead: Mock<(read: ChatFindIndexRead | null) => void>;
  /**
   * `ChatSessionState.queuePauseReasonProtocolSupported` as
   * `TranscriptQueuePauseReasonSupportContext` carries it; `null` is the
   * context's own default.
   */
  readonly support: boolean | null;
}): {
  readonly getAdapter: () => ChatFindAdapter;
  readonly getController: () => ControllerHandle;
  readonly setTranscript: (next: TranscriptState) => void;
  /** The session's answer changes, as a re-open after a reconnect makes it. */
  readonly setSupport: (next: boolean | null) => void;
  /** The reader navigates elsewhere: a minimap pick, a gesture. */
  readonly navigateAway: () => void;
  readonly scrollToLocation: Mock;
} {
  let registered: ChatFindAdapter | null = null;
  let controller: ControllerHandle | null = null;
  let transcriptNow = input.initial;
  let support = input.support;
  // `ChatMessages`' reader-navigation generation: a gesture or a navigation
  // bumps it, and so does find's own scroll, which cancels manual navigation.
  let navigationGeneration = 0;
  const tileFindContext = {
    tileInstanceId: TILE_INSTANCE_ID,
    registerAdapter: (adapter: TileFindAdapter) => {
      registered = adapter as ChatFindAdapter;
      return () => {
        if (registered === adapter) registered = null;
      };
    },
  };
  const forceStore = createChatFindForceStore();
  const callbacks = {
    scrollToLocation: vi.fn(),
    cancelManualNavigation: vi.fn(() => {
      navigationGeneration += 1;
    }),
    setScrolledActiveUserMessageIdIfChanged: vi.fn(),
  };
  const getScroller = (): HTMLElement => input.scroller;
  const getNavigationGeneration = (): number => navigationGeneration;

  function Harness(props: { readonly transcript: TranscriptState }) {
    const { transcript } = props;
    const messagesRef = useRef(transcript.messages);
    const windowRef = useRef(transcript.window);
    const rowIndexByKeyRef = useRef<ReadonlyMap<string, number>>(new Map());
    // Declared before the controller, so its own layout effects read these.
    useLayoutEffect(() => {
      messagesRef.current = transcript.messages;
      windowRef.current = transcript.window;
      rowIndexByKeyRef.current = new Map(
        transcript.messages.map((message, index) => [message.id, index]),
      );
    }, [transcript]);
    const backgroundToolBlockIdsRef = useRef(EMPTY_PROMOTED);
    const getFindCoverageMessage = useCallback(
      () => chatFindCoverageMessage(unhydratedRowCount(windowRef.current)),
      [],
    );
    const getFindPlacement = useCallback(
      () => chatFindTranscriptPlacement(windowRef.current),
      [],
    );
    const find = useChatFindController({
      instanceId: TILE_INSTANCE_ID,
      messages: transcript.messages,
      messagesRef,
      backgroundToolBlockIds: EMPTY_PROMOTED,
      backgroundToolBlockIdsRef,
      getFindCoverageMessage,
      getFindPlacement,
      requestIndexJump: input.requestIndexJump,
      requestIndexRead: input.requestIndexRead,
      rowIndexByKeyRef,
      getScroller,
      scrollToLocation: callbacks.scrollToLocation,
      cancelManualNavigation: callbacks.cancelManualNavigation,
      getNavigationGeneration,
      setScrolledActiveUserMessageIdIfChanged:
        callbacks.setScrolledActiveUserMessageIdIfChanged,
      openSubagentId: null,
      getSubagentViewRoot: () => null,
    });
    useChatFindIndexFeed({
      client: input.client,
      hostId: mockLocalHostEntry.hostId,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      demandSource: find.indexDemand,
      hasUnhydratedRows: unhydratedRowCount(transcript.window) > 0,
      onAnswer: find.setIndexAnswer,
    });
    useLayoutEffect(() => {
      controller = find;
    });
    return null;
  }

  // Always the Provider, so a change of answer re-renders the tile rather
  // than remounting it (a `null` value is the context's default).
  function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <TranscriptQueuePauseReasonSupportContext value={support}>
        <QueryClientProvider client={input.queryClient}>
          <ChatFindForceTileInstanceIdContext.Provider value={TILE_INSTANCE_ID}>
            <ChatFindForceStoreContext.Provider value={forceStore}>
              <TileFindContext.Provider value={tileFindContext}>
                {props.children}
              </TileFindContext.Provider>
            </ChatFindForceStoreContext.Provider>
          </ChatFindForceTileInstanceIdContext.Provider>
        </QueryClientProvider>
      </TranscriptQueuePauseReasonSupportContext>
    );
  }

  const rendered = render(<Harness transcript={input.initial} />, {
    wrapper: Wrapper,
  });
  return {
    getAdapter: () => {
      if (registered === null) throw new Error("adapter did not register");
      return registered;
    },
    getController: () => {
      if (controller === null) throw new Error("controller did not mount");
      return controller;
    },
    setTranscript: (next) => {
      transcriptNow = next;
      rendered.rerender(<Harness transcript={next} />);
    },
    setSupport: (next) => {
      support = next;
      rendered.rerender(<Harness transcript={transcriptNow} />);
    },
    navigateAway: () => {
      navigationGeneration += 1;
    },
    scrollToLocation: callbacks.scrollToLocation,
  };
}

// ---------------------------------------------------------------------------
// Painting (copied verbatim from chat-find-index-backed.test.tsx).

/** `mountRow` threads `support` through as `buildChatFindRows`'s 5th argument. */
function mountRow(
  scroller: HTMLElement,
  message: ChatMessageModel,
  support: boolean | null,
): string {
  const [row] = buildChatFindRows([message], TILE_INSTANCE_ID, EMPTY_PROMOTED, {
    hideReasoning: false,
    queuePauseReasonProtocolSupported: support,
  });
  const element = document.createElement("div");
  element.dataset.messageId = message.id;
  for (const unit of row.units) {
    const unitElement = document.createElement("div");
    unitElement.dataset.chatFindUnit = unit.unitId;
    unitElement.textContent = unit.text;
    element.append(unitElement);
  }
  scroller.append(element);
  const [first] = row.units;
  return first.unitId;
}

class TestHighlight {
  readonly ranges: ReadonlyArray<Range>;

  constructor(...ranges: ReadonlyArray<Range>) {
    this.ranges = ranges;
  }
}

function installMockHighlights(): {
  readonly values: ReadonlyMap<string, TestHighlight>;
  readonly restore: () => void;
} {
  const previousCss = globalThis.CSS;
  const previousHighlight = globalThis.Highlight;
  const values = new Map<string, TestHighlight>();
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: TestHighlight,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      highlights: {
        set: (name: string, highlight: TestHighlight) => {
          values.set(name, highlight);
        },
        delete: (name: string) => {
          values.delete(name);
        },
      },
    },
  });
  return {
    values,
    restore: () => {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        writable: true,
        value: previousCss,
      });
      Object.defineProperty(globalThis, "Highlight", {
        configurable: true,
        writable: true,
        value: previousHighlight,
      });
    },
  };
}

let frames: FrameRequestCallback[] = [];

function installFrameQueue(): () => void {
  frames = [];
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      frames[id - 1] = () => undefined;
    });
  return () => {
    request.mockRestore();
    cancel.mockRestore();
  };
}

function flushFrames(): void {
  act(() => {
    for (let index = 0; index < frames.length; index += 1) {
      frames[index](performance.now());
      frames[index] = () => undefined;
    }
  });
}

// ---------------------------------------------------------------------------
// Shared fixtures - copied from routing-settled-notice.test.ts and
// chat-message-assistant-body-hidden-notices.test.tsx (round-10 files), so the
// literal strings match production exactly.

const CANCELLATION_TITLE =
  "Fallback ended - no further providers will be tried for this turn";
// The notice's message carries the query, so the index (which holds a
// notice's title AND message) really answers "needle" for it.
const SETTLED_MESSAGE = "What was tried near the needle is recorded below.";
const CANCELLATION_INDEX_TEXT = `${CANCELLATION_TITLE}\n${SETTLED_MESSAGE}`;

function cancellationNotice(id: string): ProviderNoticeSegment {
  return {
    id,
    kind: "provider_notice",
    status: "completed",
    noticeKind: "fallback_settled",
    tone: "info",
    title: CANCELLATION_TITLE,
    message: SETTLED_MESSAGE,
    details: [{ label: "Code", value: "FALLBACK_CANCELLED" }],
    receipt: null,
    parentId: null,
  };
}

function exhaustedNotice(id: string): MessageSegment {
  return {
    id,
    kind: "provider_notice",
    status: "completed",
    noticeKind: "fallback_settled",
    tone: "info",
    title: CANCELLATION_TITLE,
    message: SETTLED_MESSAGE,
    details: [{ label: "Code", value: "FALLBACK_EXHAUSTED" }],
    receipt: null,
    parentId: null,
  };
}

function queuePausedNotice(id: string, message: string): MessageSegment {
  return {
    id,
    kind: "error",
    message,
    recoverable: true,
    code: QUEUE_PAUSED_AFTER_ERROR_CODE,
    failure: null,
  };
}

describe("chat find: an older index hit is a candidate until confirmed (F14)", () => {
  let scroller: HTMLElement;
  let restoreFrames: () => void;
  let requestIndexJump: Mock<(messageId: string) => void>;
  let requestIndexRead: Mock<(read: ChatFindIndexRead | null) => void>;

  beforeEach(() => {
    scroller = document.createElement("div");
    document.body.append(scroller);
    restoreFrames = installFrameQueue();
    requestIndexJump = vi.fn<(messageId: string) => void>();
    requestIndexRead = vi.fn<(read: ChatFindIndexRead | null) => void>();
  });

  afterEach(() => {
    cleanup();
    restoreFrames();
    scroller.remove();
    vi.restoreAllMocks();
  });

  const NEW_TEXT = "a recent needle";

  // -------------------------------------------------------------------------
  // F14-1 / F14-2: the cancellation notice, hidden unconditionally. The row's
  // ONLY matching text is that notice, so its whole message is a candidate.

  it("F14-1: an unloaded notice-only hit is a candidate, not counted, until read", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-cancel",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-cancel",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-cancel", "t-cancel", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      // NEW CONTRACT: the candidate is never in `total` before it is read.
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    expect(adapter.getSnapshot()).toMatchObject({
      total: 1,
      current: 1,
    });
  });

  it("F14-2: stepping onto the candidate reads it, then DROPS on hydration (still hidden)", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-cancel",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const totalHistory: number[] = [];
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-cancel",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-cancel", "t-cancel", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();
    adapter.subscribe(() => {
      totalHistory.push(adapter.getSnapshot().total);
    });

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });

    // Step onto the candidate.
    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-cancel",
      // Unheld (its row was never hydrated, so the window has no record of
      // it): the read names the record, and the host locates its row.
      target: "a-cancel",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();
    expect(find.scrollToLocation).not.toHaveBeenCalled();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      coverageMessage: CAVEAT_CHECKING,
    });

    // Hydrate: the notice is still hidden (unconditional hide), so the client
    // scan finds nothing on this row - the candidate is DROPPED.
    const hydrated: TranscriptState = transcriptOf(
      [
        assistantSegmentsRowSpec({
          rowId: "assistant:t-cancel",
          persistentMessageId: "a-cancel",
          createdAt: 20,
          segments: [cancellationNotice("a-cancel")],
        }),
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
    act(() => {
      find.setTranscript(hydrated);
    });

    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    // NEW CONTRACT: never advertised at any point in the recorded history.
    expect(totalHistory.every((total) => total <= 1)).toBe(true);
    // The walk continues in the same direction (previous); no other older
    // stop remains, so it wraps to the loaded match.
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
  });

  // -------------------------------------------------------------------------
  // F14-3/4/5: the queue-paused notice under the three support states.

  const QUEUE_MESSAGE =
    "A queued needle message was held because this turn ended.";

  function queuePausedScenario(support: boolean | null) {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-queue",
          tier: "notice",
          createdAt: 20,
          text: QUEUE_MESSAGE,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-queue",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-queue", "t-queue", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support,
    });
    return { host, find };
  }

  it("F14-3: queue-paused notice, support=null (no session) - DROPPED through hydration", async () => {
    const { find } = queuePausedScenario(null);
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    const hydrated = transcriptOf(
      [
        assistantSegmentsRowSpec({
          rowId: "assistant:t-queue",
          persistentMessageId: "a-queue",
          createdAt: 20,
          segments: [queuePausedNotice("a-queue", QUEUE_MESSAGE)],
        }),
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
  });

  it("F14-4: queue-paused notice, support=true (protocol supported) - DROPPED through hydration", async () => {
    const { find } = queuePausedScenario(true);
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    const hydrated = transcriptOf(
      [
        assistantSegmentsRowSpec({
          rowId: "assistant:t-queue",
          persistentMessageId: "a-queue",
          createdAt: 20,
          segments: [queuePausedNotice("a-queue", QUEUE_MESSAGE)],
        }),
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
  });

  it("F14-5 (control): queue-paused notice, support=false (protocol NOT supported) - CONFIRMED and painted", async () => {
    const highlights = installMockHighlights();
    const { find } = queuePausedScenario(false);
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    const hydratedModel = assistantSegmentsRow({
      rowId: "assistant:t-queue",
      persistentMessageId: "a-queue",
      createdAt: 20,
      segments: [queuePausedNotice("a-queue", QUEUE_MESSAGE)],
    });
    const hydrated = transcriptOf(
      [
        {
          rowId: "assistant:t-queue",
          createdAt: 20,
          role: "assistant",
          records: [assistantRecord("a-queue", "t-queue", 20)],
          model: hydratedModel,
        },
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(2);

    const unitId = mountRow(scroller, hydratedModel, false);
    expect(unitId).toBe(chatFindSegmentUnitId("a-queue"));
    act(() => {
      find
        .getController()
        .onTranscriptLandingSettled("assistant:t-queue", "landed");
    });
    flushFrames();
    expect(adapter.getSnapshot()).toMatchObject({
      activeUnitId: unitId,
      exactHighlight: "painted",
    });
    highlights.restore();
  });

  // -------------------------------------------------------------------------
  // F14-6 (control): the EXHAUSTED notice shares F14-1's title but is never
  // hidden - it should already behave correctly once the candidate/confirm
  // seams exist.

  it("F14-6 (control): the FALLBACK_EXHAUSTED notice is CONFIRMED and painted", async () => {
    const highlights = installMockHighlights();
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-exhausted",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-exhausted",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-exhausted", "t-exhausted", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    const hydratedModel = assistantSegmentsRow({
      rowId: "assistant:t-exhausted",
      persistentMessageId: "a-exhausted",
      createdAt: 20,
      segments: [exhaustedNotice("a-exhausted")],
    });
    const hydrated = transcriptOf(
      [
        {
          rowId: "assistant:t-exhausted",
          createdAt: 20,
          role: "assistant",
          records: [assistantRecord("a-exhausted", "t-exhausted", 20)],
          model: hydratedModel,
        },
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(2);
    const unitId = mountRow(scroller, hydratedModel, null);
    act(() => {
      find
        .getController()
        .onTranscriptLandingSettled("assistant:t-exhausted", "landed");
    });
    flushFrames();
    expect(adapter.getSnapshot()).toMatchObject({
      activeUnitId: unitId,
      exactHighlight: "painted",
    });
    highlights.restore();
  });

  // -------------------------------------------------------------------------
  // F14-7: the error text and the hidden notice both match; only ONE new
  // match, on the error unit.

  it("F14-7: an error and its row's hidden notice both match - one CONFIRMED match, on the error unit", async () => {
    const highlights = installMockHighlights();
    const QUERY = "needle";
    const errorSegment: MessageSegment = {
      id: "error-both",
      kind: "error",
      message: `The turn failed near the ${QUERY}.`,
      recoverable: true,
      code: "RUNTIME",
      failure: null,
    };
    // The notice's OWN occurrence of the query, distinct from the error's.
    const noticeWithQuery: ProviderNoticeSegment = {
      ...cancellationNotice("notice-both"),
      message: `What was tried near the ${QUERY} is recorded below.`,
    };
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-both",
          tier: "assistant",
          createdAt: 20,
          text: errorSegment.message,
        },
        {
          messageId: "a-both",
          tier: "notice",
          createdAt: 20,
          text: noticeWithQuery.message ?? "",
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-both",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-both", "t-both", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: QUERY, matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    const hydratedModel = assistantSegmentsRow({
      rowId: "assistant:t-both",
      persistentMessageId: "a-both",
      createdAt: 20,
      segments: [errorSegment, noticeWithQuery],
    });
    const hydrated = transcriptOf(
      [
        {
          rowId: "assistant:t-both",
          createdAt: 20,
          role: "assistant",
          records: [assistantRecord("a-both", "t-both", 20)],
          model: hydratedModel,
        },
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    // Before the step: 1 (the already-loaded "u-new" row, whose text also
    // contains "needle") + the a-both candidate, uncounted. After confirming:
    // 1 (u-new) + 1 (a-both's error unit) = 2 - the notice segment on a-both
    // is a cancellation notice (Code=FALLBACK_CANCELLED) and is unconditionally
    // hidden by `segmentsShownInTranscript`, so it contributes NO second unit;
    // that is what makes this "exactly one new match, not two".
    expect(adapter.getSnapshot().total).toBe(2);
    const unitId = mountRow(scroller, hydratedModel, null);
    expect(unitId).toBe(chatFindSegmentUnitId("error-both"));
    act(() => {
      find
        .getController()
        .onTranscriptLandingSettled("assistant:t-both", "landed");
    });
    flushFrames();
    expect(adapter.getSnapshot()).toMatchObject({
      activeUnitId: chatFindSegmentUnitId("error-both"),
      exactHighlight: "painted",
    });
    highlights.restore();
  });

  // -------------------------------------------------------------------------
  // F14-10..13: `onIndexReadFailed` and the general candidate lifecycle.
  // Unlike F14-4/F14-5, `onIndexReadFailed` is NOT a not-yet-built seam -
  // `useChatFindController` already exposes it (see `use-chat-find-controller.ts`)
  // and the adapter already implements `notifyIndexReadFailed`
  // (`chat-find-adapter.ts`). These cells drive the REAL callback rather than
  // a mock, so any red here is a genuine behavioural mismatch, not a missing
  // export.

  it("F14-10: onIndexReadFailed marks the candidate unreadable and the walk continues (distinct from a hydration drop)", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-cancel",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const totalHistory: number[] = [];
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-cancel",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-cancel", "t-cancel", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();
    adapter.subscribe(() => {
      totalHistory.push(adapter.getSnapshot().total);
    });

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });

    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-cancel",
      target: "a-cancel",
    });

    // The failure is signalled directly - no hydration update at all.
    // F14-2's trigger (a `setTranscript` that hydrates the row and lets the
    // client scan run) never fires here.
    act(() => {
      find.getController().onIndexReadFailed("a-cancel");
    });

    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    // NEW CONTRACT: never advertised at any point in the recorded history,
    // same as a hydration-based drop.
    expect(totalHistory.every((total) => total <= 1)).toBe(true);
    // The walk continues in the same direction; no other older stop remains,
    // so it wraps to the loaded match - the same OUTCOME F14-2 reaches, by a
    // different trigger.
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
  });

  it("F14-11: a late onIndexReadFailed (TTL firing after the read already settled) is a no-op", async () => {
    // Reaches a settled state the same way F14-10 does, then fires the SAME
    // failure callback again for the SAME messageId - the shape a TTL timer
    // takes when it outlives the read it was bounding, per
    // `use-chat-find-index-read.ts`'s own TTL effect racing its locate-missing
    // effect: both ultimately call `onReadFailed` for one read, and the second
    // call must be inert once the first has already ended it.
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-cancel",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-cancel",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-cancel", "t-cancel", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    act(() => {
      find.getController().onIndexReadFailed("a-cancel");
    });
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
    requestIndexRead.mockClear();

    // The read for "a-cancel" already ended (verdict: unreadable, no read
    // pending). A TTL timer that had been racing that read and fires only NOW
    // names the same messageId - `notifyIndexReadFailed`'s own guard
    // (`this.pendingRead === null || read.hit.messageId !== messageId`) must
    // ignore it.
    act(() => {
      find.getController().onIndexReadFailed("a-cancel");
    });

    expect(requestIndexRead).not.toHaveBeenCalled();
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
  });

  it("F14-12: an errored locate on one candidate hands the step to the NEXT older candidate", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-cancel-near",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        {
          messageId: "a-cancel-far",
          tier: "notice",
          createdAt: 10,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-cancel-far",
            createdAt: 10,
            role: "assistant",
            records: [assistantRecord("a-cancel-far", "t-cancel-far", 10)],
            model: null,
          },
          {
            rowId: "assistant:t-cancel-near",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-cancel-near", "t-cancel-near", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        CAVEAT_MAY_MATCH_MANY(2),
      );
    });

    // Steps onto the NEARER candidate first (closest to the loaded match).
    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-cancel-near",
      target: "a-cancel-near",
    });

    // Its locate errors. This file's harness has no direct hook into
    // `chat.locateRow` itself, so the errored-locate case is exercised at the
    // layer that actually receives it: the adapter's `onIndexReadFailed`,
    // which is exactly what `useChatFindIndexRead` calls for a rejected or
    // errored locate - per that hook's own doc comment: "A read the host
    // settles without a row, one it rejects, and one still outstanding after
    // the jump TTL ... all fail the same way: `onReadFailed`".
    act(() => {
      find.getController().onIndexReadFailed("a-cancel-near");
    });

    // The walk carries on to the NEXT older candidate rather than giving up -
    // it does NOT fall back to `requestIndexRead(null)` here, because another
    // candidate remains to be read first.
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-cancel-far",
      target: "a-cancel-far",
    });

    act(() => {
      find.getController().onIndexReadFailed("a-cancel-far");
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    // Every older candidate failed: the walk wraps all the way back to the
    // one loaded match.
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
  });

  it("F14-13: a fresh search re-treats a previously-failed candidate as an unread candidate again", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-cancel",
          tier: "notice",
          createdAt: 20,
          text: CANCELLATION_INDEX_TEXT,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-cancel",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-cancel", "t-cancel", 20)],
            model: null,
          },
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.previous();
    });
    act(() => {
      find.getController().onIndexReadFailed("a-cancel");
    });
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });

    // A fresh search (a new requestId, not a hydration update or a rows
    // change) resets `verdicts` unconditionally (`search()`'s own
    // `this.verdicts.clear()`), so the message this run marked unreadable is
    // an unread CANDIDATE again in the new run - the unreadable verdict does
    // not survive re-opening the search.
    requestIndexRead.mockClear();
    act(() => {
      void adapter.search({ requestId: 2, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });

    act(() => {
      void adapter.previous();
    });
    // Read again, from scratch - a fresh candidate, not the exhausted verdict
    // carried over from the previous search.
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-cancel",
      target: "a-cancel",
    });
  });

  // A read's verdict outlives the rows it read: once they are evicted again, a
  // confirmed message stays a counted stop and a dropped one is never a
  // candidate again, so neither is read twice.
  it("keeps a read's verdict through eviction: confirmed stays counted, dropped is never read again", async () => {
    const REAL = "an old needle that paints";
    const host = hostFixture(
      fakeIndex([
        { messageId: "u-real", tier: "user", createdAt: 10, text: REAL },
        // The index holds the query; the row paints something else.
        {
          messageId: "u-phantom",
          tier: "user",
          createdAt: 20,
          text: "/needle as the index holds it",
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const transcript = (hydrated: boolean): TranscriptState =>
      transcriptOf(
        [
          userSpec("u-real", 10, REAL, hydrated),
          userSpec("u-phantom", 20, "$other as the row paints it", hydrated),
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      );
    const find = renderFind({
      initial: transcript(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        CAVEAT_MAY_MATCH_MANY(2),
      );
    });
    expect(adapter.getSnapshot()).toMatchObject({ total: 1, current: 1 });

    // Step back onto the nearer candidate (u-phantom) and read it: dropped.
    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "u-phantom",
      target: "u-phantom",
    });
    act(() => {
      find.setTranscript(transcript(true));
    });
    // Dropped, and the step went on to u-real - already hydrated by the same
    // transcript, so it is a loaded match now and the step lands on it.
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 1 });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);

    // Evict both older rows again.
    act(() => {
      find.setTranscript(transcript(false));
    });
    requestIndexRead.mockClear();
    // u-real was seen matching: still counted, as an older message. u-phantom
    // was seen empty: no longer a candidate, so no "may match" remains.
    expect(adapter.getSnapshot().total).toBe(2);
    expect(adapter.getSnapshot().coverageMessage).not.toContain("may match");

    // Walking the whole ring reads nothing: neither message is unread.
    act(() => {
      void adapter.next();
    });
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).not.toHaveBeenCalled();
  });

  // A verdict is about what the rows PAINT, and the session's queue-notice
  // answer decides that. A re-open after a reconnect can move the answer
  // either way (`chat-session-store-queue-pause-reason-support.test.ts`), so
  // a change re-judges every hit, even one whose rows are evicted.
  function queueRowSpec(hydrated: boolean): RowSpec {
    return {
      rowId: "assistant:t-queue",
      createdAt: 20,
      role: "assistant",
      records: [assistantRecord("a-queue", "t-queue", 20)],
      model: hydrated
        ? assistantSegmentsRow({
            rowId: "assistant:t-queue",
            persistentMessageId: "a-queue",
            createdAt: 20,
            segments: [queuePausedNotice("a-queue", QUEUE_MESSAGE)],
          })
        : null,
    };
  }

  function queueTranscript(hydrated: boolean): TranscriptState {
    return transcriptOf(
      [
        // Keeps the transcript partial once the queue row is hydrated.
        userSpec("u-old", 5, "an unrelated older note", false),
        queueRowSpec(hydrated),
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
  }

  function queueHost() {
    return hostFixture(
      fakeIndex([
        {
          messageId: "a-queue",
          tier: "notice",
          createdAt: 20,
          text: QUEUE_MESSAGE,
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
  }

  it.each([{ from: null }, { from: true }])(
    "re-judges a dropped queue notice when the answer turns from $from to false: a candidate again, read and confirmed",
    async ({ from }) => {
      const host = queueHost();
      const find = renderFind({
        initial: queueTranscript(false),
        client: host.client,
        queryClient: host.queryClient,
        scroller,
        requestIndexJump,
        requestIndexRead,
        support: from,
      });
      const adapter = find.getAdapter();

      act(() => {
        void adapter.search({
          requestId: 1,
          query: "needle",
          matchCase: false,
        });
      });
      await waitFor(() => {
        expect(adapter.getSnapshot().coverageMessage).toBe(
          CAVEAT_MAY_MATCH_ONE,
        );
      });
      // Hydrated by a scroll under `from`: the notice is hidden, so dropped.
      act(() => {
        find.setTranscript(queueTranscript(true));
      });
      expect(adapter.getSnapshot().coverageMessage).not.toContain("may match");
      // Evicted: the dropped verdict holds.
      act(() => {
        find.setTranscript(queueTranscript(false));
      });
      expect(adapter.getSnapshot().coverageMessage).not.toContain("may match");
      expect(adapter.getSnapshot().total).toBe(1);

      // The session re-opens against a host that draws the notice.
      act(() => {
        find.setSupport(false);
      });
      expect(adapter.getSnapshot()).toMatchObject({
        total: 1,
        coverageMessage: CAVEAT_MAY_MATCH_ONE,
      });

      act(() => {
        void adapter.previous();
      });
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "a-queue",
        target: "a-queue",
      });
      act(() => {
        find.setTranscript(queueTranscript(true));
      });
      expect(requestIndexRead).toHaveBeenLastCalledWith(null);
      expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 1 });
    },
  );

  it("re-judges a confirmed queue notice when the answer turns true: no longer counted, read and dropped", async () => {
    const host = queueHost();
    const find = renderFind({
      initial: queueTranscript(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: false,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // Hydrated by a scroll under `false`: the notice paints, so confirmed.
    act(() => {
      find.setTranscript(queueTranscript(true));
    });
    expect(adapter.getSnapshot().total).toBe(2);
    // Evicted: still counted, as an older message.
    act(() => {
      find.setTranscript(queueTranscript(false));
    });
    expect(adapter.getSnapshot().total).toBe(2);
    expect(adapter.getSnapshot().coverageMessage).not.toContain("may match");

    // The session re-opens against a host that hides the notice.
    act(() => {
      find.setSupport(true);
    });
    expect(adapter.getSnapshot()).toMatchObject({
      total: 1,
      coverageMessage: CAVEAT_MAY_MATCH_ONE,
    });

    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-queue",
      target: "a-queue",
    });
    act(() => {
      find.setTranscript(queueTranscript(true));
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
    expect(adapter.getSnapshot().coverageMessage).not.toContain("may match");
  });

  // A read is slow; the reader may be somewhere else by the time it lands.
  // What it learned still holds, but it no longer owns the viewport.
  function realOldTranscript(hydrated: boolean): TranscriptState {
    return transcriptOf(
      [
        userSpec("u-real", 10, "an old needle that paints", hydrated),
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
  }

  function realOldHost() {
    return hostFixture(
      fakeIndex([
        {
          messageId: "u-real",
          tier: "user",
          createdAt: 10,
          text: "an old needle that paints",
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
  }

  it("keeps what a read learned after the reader navigated away, and does not take the viewport back", async () => {
    const host = realOldHost();
    const find = renderFind({
      initial: realOldTranscript(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // The search's own reveal of the loaded match runs first.
    flushFrames();

    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "u-real",
      target: "u-real",
    });
    // A minimap pick while the read is out.
    find.navigateAway();
    find.scrollToLocation.mockClear();

    act(() => {
      find.setTranscript(realOldTranscript(true));
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    // Confirmed and counted; the active match is still the one it was.
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 2 });
    flushFrames();
    expect(find.scrollToLocation).not.toHaveBeenCalled();
  });

  it("lets a press in the same direction reclaim a read the reader had moved away from", async () => {
    const host = realOldHost();
    const find = renderFind({
      initial: realOldTranscript(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    flushFrames();

    act(() => {
      void adapter.previous();
    });
    find.navigateAway();
    // The reader asks for the same step again while the read is still out.
    act(() => {
      void adapter.previous();
    });
    // One read, not two.
    expect(
      requestIndexRead.mock.calls.filter(([read]) => read !== null),
    ).toHaveLength(1);
    find.scrollToLocation.mockClear();

    act(() => {
      find.setTranscript(realOldTranscript(true));
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    // The press made the step theirs again: it lands on u-real.
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 1 });
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();
  });

  it("does not carry a step on past a dropped read once the reader navigated away", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "u-real",
          tier: "user",
          createdAt: 10,
          text: "an old needle that paints",
        },
        // The index holds the query; the row paints something else.
        {
          messageId: "u-phantom",
          tier: "user",
          createdAt: 20,
          text: "/needle as the index holds it",
        },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const transcript = (phantomHydrated: boolean): TranscriptState =>
      transcriptOf(
        [
          userSpec("u-real", 10, "an old needle that paints", false),
          userSpec(
            "u-phantom",
            20,
            "$other as the row paints it",
            phantomHydrated,
          ),
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      );
    const find = renderFind({
      initial: transcript(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        CAVEAT_MAY_MATCH_MANY(2),
      );
    });
    flushFrames();

    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "u-phantom",
      target: "u-phantom",
    });
    find.navigateAway();
    find.scrollToLocation.mockClear();

    act(() => {
      find.setTranscript(transcript(true));
    });
    // Dropped, and the step is over: u-real is not read on the reader's
    // behalf, and stays a candidate.
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({
      total: 1,
      current: 1,
      coverageMessage: CAVEAT_MAY_MATCH_ONE,
    });
    flushFrames();
    expect(find.scrollToLocation).not.toHaveBeenCalled();
  });

  // A step back past the oldest entry waits on the next index page; the
  // reader can move before it arrives. The read the page leads to belongs to
  // that step, so it inherits the step's generation, not a fresh one.
  function pageTwoTranscript(): TranscriptState {
    return transcriptOf(
      [
        userSpec("u-real", 1, "an old needle that paints", false),
        // Page 1: held rows the index says match and the rows do not paint.
        ...Array.from({ length: 100 }, (_unused, index) =>
          userSpec(`u-${index}`, index + 2, `a phantom ${index}`, true),
        ),
        userSpec("u-new", 1000, NEW_TEXT, true),
      ],
      null,
    );
  }

  function pageTwoHydrated(): TranscriptState {
    return transcriptOf(
      [
        userSpec("u-real", 1, "an old needle that paints", true),
        ...Array.from({ length: 100 }, (_unused, index) =>
          userSpec(`u-${index}`, index + 2, `a phantom ${index}`, true),
        ),
        userSpec("u-new", 1000, NEW_TEXT, true),
      ],
      null,
    );
  }

  async function steppedIntoPageTwo(options: {
    readonly moveWhileLoading: boolean;
  }) {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "u-real",
          tier: "user",
          createdAt: 1,
          text: "an old needle that paints",
        },
        ...Array.from({ length: 100 }, (_unused, index) => ({
          messageId: `u-${index}`,
          tier: "user" as const,
          createdAt: index + 2,
          text: `needle ${index}`,
        })),
      ]),
    );
    const searchCount = (): number =>
      host.messenger.calls.filter((call) => call.method === "chat.search")
        .length;
    const find = renderFind({
      initial: pageTwoTranscript(),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCount()).toBe(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Page 1 is spent on arrival: every hit is a held row that paints no match.
    expect(adapter.getSnapshot()).toMatchObject({ total: 1, current: 1 });
    expect(adapter.getSnapshot().coverageMessage).not.toContain("may match");
    flushFrames();

    // Back from the one loaded match, the oldest entry: page 2 is asked for.
    act(() => {
      void adapter.previous();
    });
    // A minimap pick while it loads.
    if (options.moveWhileLoading) find.navigateAway();
    await waitFor(() => {
      expect(searchCount()).toBe(2);
    });
    await waitFor(() => {
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "u-real",
        target: "u-real",
      });
    });
    find.scrollToLocation.mockClear();
    act(() => {
      find.setTranscript(pageTwoHydrated());
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    return { adapter, find };
  }

  it("does not let a step that waited on a page take the viewport after the reader moved", async () => {
    const { adapter, find } = await steppedIntoPageTwo({
      moveWhileLoading: true,
    });
    // Learned and counted; the active match is still the one it was.
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 2 });
    flushFrames();
    expect(find.scrollToLocation).not.toHaveBeenCalled();
  });

  it("lands a step that waited on a page when the reader stayed put", async () => {
    const { adapter, find } = await steppedIntoPageTwo({
      moveWhileLoading: false,
    });
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 1 });
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();
  });

  it("still lands a confirmed read when only find's own reveal ran while it was out", async () => {
    const host = realOldHost();
    const find = renderFind({
      initial: realOldTranscript(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
      support: null,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // The search's reveal of the loaded match is still queued when the step
    // starts the read.
    act(() => {
      void adapter.previous();
    });
    find.scrollToLocation.mockClear();
    flushFrames();
    // Precondition: find's own scroll ran after the read began.
    expect(find.scrollToLocation).toHaveBeenCalled();
    find.scrollToLocation.mockClear();

    act(() => {
      find.setTranscript(realOldTranscript(true));
    });
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 1 });
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();
  });
});

/** Helper used above: a `RowSpec` wrapping `assistantSegmentsRow` as `model`. */
function assistantSegmentsRowSpec(input: {
  readonly rowId: string;
  readonly persistentMessageId: string;
  readonly createdAt: number;
  readonly segments: ReadonlyArray<MessageSegment>;
}): RowSpec {
  return {
    rowId: input.rowId,
    createdAt: input.createdAt,
    role: "assistant",
    records: [
      assistantRecord(input.persistentMessageId, input.rowId, input.createdAt),
    ],
    model: assistantSegmentsRow(input),
  };
}

// ===========================================================================
// Census: index text the transcript does not paint, one row per case. Each
// row precondition-checks itself: the query IS in the fake index's text, and
// is NOT in any unit `buildChatFindRows` produces for the HYDRATED version of
// the same message - so the row cannot pass vacuously.
// ===========================================================================

// Not a census row: a subagent-owned tool call's inputSummary IS painted - the
// card draws its conversation, the nested tool's header among it - so the
// hydrated projection carries it and an index hit on it is confirmed like any
// painted text. Pinned below so the case cannot drift back into the census.
const SUBAGENT_NESTED_TOOL_MODEL: ChatMessageModel = assistantSegmentsRow({
  rowId: "assistant:t-subagent-tool",
  persistentMessageId: "a-subagent-tool",
  createdAt: 5,
  segments: [
    {
      id: "subagent-1",
      kind: "subagent",
      name: "Researcher",
      agentType: "analysis",
      task: "Investigate",
      progressUpdates: [],
      result: null,
      isStreaming: false,
      endState: null,
      stopped: false,
      startedAt: 1,
      durationMs: null,
      spawnToolCallId: null,
      parentId: null,
      workflowMeta: null,
      children: [
        {
          id: "nested-tool-1",
          kind: "tool",
          toolName: "grep",
          inputSummary: "grep needle in nested tool",
          inputDetail: null,
          taskTodoItems: null,
          error: null,
          agentMessageSend: null,
          managedCommand: null,
          agentMessageReceipt: null,
          isStreaming: false,
          endState: null,
          stopped: false,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          imageResults: [],
          page: null,
          mcpApp: null,
          durationMs: null,
          startedAt: 0,
          parentId: "subagent-1",
        },
      ],
    },
  ],
});

interface CensusRow {
  readonly name: string;
  readonly indexText: string;
  readonly indexTier: ChatSearchTier;
  readonly query: string;
  readonly hydratedModel: ChatMessageModel;
}

const CENSUS_ROWS: ReadonlyArray<CensusRow> = [
  {
    // 1. A Codex retry error after its turn ended: `codexRetryVisibility` is
    // "hidden", and `renderAssistantTurnSlice` (rendered-messages.ts) filters
    // the block out of `visibleBlocks` before any segment is built - so the
    // hydrated row simply has no segment for it.
    name: "a Codex retry error after its turn ended",
    indexText: "Reconnecting to Codex: needle timeout",
    indexTier: "assistant",
    query: "needle",
    hydratedModel: assistantSegmentsRow({
      rowId: "assistant:t-retry",
      persistentMessageId: "a-retry",
      createdAt: 5,
      segments: [],
    }),
  },
  {
    // 2. An approval's `inputSummary` - find indexes only the verdict and
    // `toolName ?? description` (approvalHeaderSearchText).
    name: "an approval's inputSummary",
    indexText: "reading needle.txt before approval",
    indexTier: "card",
    query: "needle",
    hydratedModel: assistantSegmentsRow({
      rowId: "assistant:t-approval",
      persistentMessageId: "a-approval",
      createdAt: 5,
      segments: [
        {
          id: "approval-1",
          kind: "approval",
          toolName: "Read",
          description: null,
          inputSummary: "reading needle.txt before approval",
          inputDetail: null,
          decision: null,
        },
      ],
    }),
  },
  {
    // 3. A markdown link target: `[text](url)` - `tokenToText` for a "link"
    // token returns the LABEL's tokens, never the href.
    name: "a markdown link's URL, [text](url)",
    indexText: "see https://example.com/needle for details",
    indexTier: "assistant",
    query: "needle",
    hydratedModel: assistantSegmentsRow({
      rowId: "assistant:t-link",
      persistentMessageId: "a-link",
      createdAt: 5,
      segments: [
        {
          id: "link-1",
          kind: "text",
          markdown: "see [the docs](https://example.com/needle) for details",
          isStreaming: false,
        },
      ],
    }),
  },
  {
    // 4. A TRAYCER_NEXT_STEPS option line - find indexes only the prose
    // (`part.prose`), never an option's own `prompt` text.
    name: "a TRAYCER_NEXT_STEPS option line's own text",
    indexText: "pick the needle option next",
    indexTier: "assistant",
    query: "needle",
    hydratedModel: assistantSegmentsRow({
      rowId: "assistant:t-next-steps",
      persistentMessageId: "a-next-steps",
      createdAt: 5,
      segments: [
        {
          id: "next-steps-1",
          kind: "text",
          markdown: [
            "Visible assistant answer.",
            "",
            "<TRAYCER_NEXT_STEPS>",
            "Choose one of these next steps.",
            "",
            "- [] : pick the needle option next",
            "</TRAYCER_NEXT_STEPS>",
          ].join("\n"),
          isStreaming: false,
        },
      ],
    }),
  },
  {
    // 5. A `$`-written skill chip - literal fixture copied from
    // chat-find-projection.test.ts's own "$-triggered chip" cell: the index
    // holds the canonical `/name`, the rendered chip is `$name`.
    name: "a $-written skill chip (index holds /name, DOM paints $name)",
    indexText: "/traycer-implement the runtime ticket",
    indexTier: "user",
    query: "/traycer-implement",
    hydratedModel: {
      ...makeMessageAt(0, "user", 5),
      id: "u-chip",
      persistentMessageId: "u-chip",
      content: "",
      structuredContent: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "slashCommand",
                attrs: { commandName: "traycer-implement", trigger: "$" },
              },
              { type: "text", text: " the runtime ticket" },
            ],
          },
        ],
      },
    },
  },
  {
    // 6. A `fallback_applied` notice's `message` field - only the title is
    // painted (`providerNoticeSegmentSearchText`'s `fallback_applied` branch
    // discards `message`).
    name: "a fallback_applied notice's message field",
    indexText: "Moved routing because of a needle in the pipeline",
    indexTier: "notice",
    query: "needle",
    hydratedModel: assistantSegmentsRow({
      rowId: "assistant:t-applied",
      persistentMessageId: "a-applied",
      createdAt: 5,
      segments: [
        {
          id: "applied-1",
          kind: "provider_notice",
          status: "completed",
          noticeKind: "fallback_applied",
          tone: "info",
          title: "Switched providers",
          message: "Moved routing because of a needle in the pipeline",
          details: [],
          receipt: null,
          parentId: null,
        },
      ],
    }),
  },
  {
    // 7. A settled card's absorbed anchor error: `routingSettledNoticeId` +
    // `manualRungAnchorId` pair the notice with the error segment on the same
    // row; `settledCardSearchUnits` returns `[]` for the anchor segment
    // itself (`segment.id === settled.anchorId`) - its error message is
    // absorbed into the card and indexes nothing at all.
    name: "a settled card's absorbed anchor error message",
    indexText: "Failed with a needle in the response",
    indexTier: "assistant",
    query: "needle",
    hydratedModel: assistantSegmentsRow({
      rowId: "assistant:t-settled",
      persistentMessageId: "a-settled",
      createdAt: 5,
      manualRungAnchorId: "anchor-error-1",
      routingSettledNoticeId: "settled-notice-1",
      segments: [
        {
          id: "anchor-error-1",
          kind: "error",
          message: "Failed with a needle in the response",
          recoverable: true,
          code: "RUNTIME",
          failure: null,
        },
        {
          id: "settled-notice-1",
          kind: "provider_notice",
          status: "completed",
          noticeKind: "fallback_settled",
          tone: "info",
          title: CANCELLATION_TITLE,
          message: null,
          details: [],
          receipt: {
            causeLabel: "Every step was tried",
            steps: [],
          },
          parentId: null,
        },
      ],
    }),
  },
];

/** The census row's message as an unhydrated (or hydrated) transcript row. */
function censusRowSpec(row: CensusRow, hydrated: boolean): RowSpec {
  const model = row.hydratedModel;
  const messageId = model.persistentMessageId ?? model.id;
  const createdAt = 5;
  return model.role === "user"
    ? {
        rowId: model.id,
        createdAt,
        role: "user",
        records: [userRecord(messageId, createdAt)],
        model: hydrated ? model : null,
      }
    : {
        rowId: model.id,
        createdAt,
        role: "assistant",
        records: [
          assistantRecord(
            messageId,
            model.id.replace(/^assistant:/, ""),
            createdAt,
          ),
        ],
        model: hydrated ? model : null,
      };
}

describe("chat find: census of index text the transcript does not paint", () => {
  let scroller: HTMLElement;
  let restoreFrames: () => void;

  beforeEach(() => {
    scroller = document.createElement("div");
    document.body.append(scroller);
    restoreFrames = installFrameQueue();
  });

  afterEach(() => {
    cleanup();
    restoreFrames();
    scroller.remove();
    vi.restoreAllMocks();
  });

  it("a subagent-owned tool call's inputSummary is painted, so the hydrated projection carries it", () => {
    const units = buildChatFindRows(
      [SUBAGENT_NESTED_TOOL_MODEL],
      TILE_INSTANCE_ID,
      EMPTY_PROMOTED,
      { hideReasoning: false, queuePauseReasonProtocolSupported: null },
    ).flatMap((projectedRow) => projectedRow.units);
    expect(
      units.some((unit) =>
        asciiLower(unit.text).includes("grep needle in nested tool"),
      ),
    ).toBe(true);
  });

  it.each(CENSUS_ROWS.map((row) => [row.name, row] as const))(
    "%s: never counted; read, then dropped",
    async (_name, row) => {
      // Precondition 1: the fake index really does hold the query.
      expect(asciiLower(row.indexText)).toContain(asciiLower(row.query));

      // Precondition 2: the hydrated projection really does NOT produce any
      // unit containing the query - otherwise this row would pass vacuously.
      const hydratedUnits = buildChatFindRows(
        [row.hydratedModel],
        TILE_INSTANCE_ID,
        EMPTY_PROMOTED,
        { hideReasoning: false, queuePauseReasonProtocolSupported: null },
      ).flatMap((projectedRow) => projectedRow.units);
      const anyUnitMatches = hydratedUnits.some((unit) =>
        asciiLower(unit.text).includes(asciiLower(row.query)),
      );
      expect(anyUnitMatches).toBe(false);

      const messageId =
        row.hydratedModel.persistentMessageId ?? row.hydratedModel.id;
      const loadedText = `a recent ${row.query}`;
      const requestIndexJump = vi.fn<(messageId: string) => void>();
      const requestIndexRead =
        vi.fn<(read: ChatFindIndexRead | null) => void>();
      const host = hostFixture(
        fakeIndex([
          {
            messageId,
            tier: row.indexTier,
            createdAt: 5,
            text: row.indexText,
          },
          {
            messageId: "u-new",
            tier: "user",
            createdAt: 100,
            text: loadedText,
          },
        ]),
      );
      const totalHistory: number[] = [];
      const find = renderFind({
        initial: transcriptOf(
          [censusRowSpec(row, false), userSpec("u-new", 100, loadedText, true)],
          null,
        ),
        client: host.client,
        queryClient: host.queryClient,
        scroller,
        requestIndexJump,
        requestIndexRead,
        support: null,
      });
      const adapter = find.getAdapter();
      adapter.subscribe(() => {
        totalHistory.push(adapter.getSnapshot().total);
      });

      act(() => {
        void adapter.search({
          requestId: 1,
          query: row.query,
          matchCase: false,
        });
      });
      await waitFor(() => {
        expect(adapter.getSnapshot().coverageMessage).toBe(
          CAVEAT_MAY_MATCH_ONE,
        );
      });
      expect(adapter.getSnapshot()).toMatchObject({ total: 1, current: 1 });

      act(() => {
        void adapter.previous();
      });
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId,
        target: messageId,
      });
      expect(requestIndexJump).not.toHaveBeenCalled();

      act(() => {
        find.setTranscript(
          transcriptOf(
            [
              censusRowSpec(row, true),
              userSpec("u-new", 100, loadedText, true),
            ],
            null,
          ),
        );
      });
      expect(requestIndexRead).toHaveBeenLastCalledWith(null);
      expect(totalHistory.every((total) => total <= 1)).toBe(true);
      expect(adapter.getSnapshot()).toMatchObject({ total: 1, current: 1 });
    },
  );
});
