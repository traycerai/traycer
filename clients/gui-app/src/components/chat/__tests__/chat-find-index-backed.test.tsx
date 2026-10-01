/**
 * Cmd+F over a windowed transcript: loaded rows keep the exact client scan,
 * older unloaded rows are answered by the host's chat-scoped `substring`
 * search, and navigating to an index hit hands the hydrated row back to the
 * client scan for the exact highlight.
 *
 * Driven over the real controller, adapter, projection and highlighter, the
 * real index hook and host query layer, a real transcript window (skeleton,
 * range serves, record ledger) and a scripted host. The fake index holds
 * documents the way the host's extraction does: one per (message, tier) for
 * user text, assistant prose, notices and card text - never tool output,
 * subagent bodies or reasoning.
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
import {
  HostRequestAbortedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import {
  chatSearchRequestSchema,
  type ChatSearchMessageHit,
  type ChatSearchRequest,
  type ChatSearchResponse,
  type ChatSearchTier,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  buildChatFindRows,
  chatFindCoverageMessage,
  type ChatFindAdapter,
} from "@/components/chat/chat-find";
import { chatFindTranscriptPlacement } from "@/components/chat/chat-find-index";
import type { ChatFindIndexRead } from "@/components/chat/chat-find-index";
import { useChatFindIndexFeed } from "@/hooks/chats/use-chat-find-index-feed";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
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
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
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

const TILE_INSTANCE_ID = "find-index-tile";
const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const EMPTY_PROMOTED: ReadonlySet<string> = new Set<string>();
const EXCLUSION_TAIL =
  "older reasoning, subagent and tool output are not indexed.";

// An older index hit is a CANDIDATE, never counted, until stepping onto it
// reads the row and the client scan confirms or drops it. Same constants as
// chat-find-index-confirm.test.tsx (read there for the exact copy).
const CAVEAT_MAY_MATCH_ONE = `1 older message may match; ${EXCLUSION_TAIL}`;
const CAVEAT_MAY_MATCH_MANY = (count: number): string =>
  `${count} older messages may match; ${EXCLUSION_TAIL}`;
const CAVEAT_MAY_MATCH_AT_LEAST = (count: number): string =>
  `At least ${count} older messages may match; ${EXCLUSION_TAIL}`;
const CAVEAT_CHECKING = "Checking an older message…";

// ---------------------------------------------------------------------------
// Records, rendered rows and the window that holds them.

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

function assistantRow(input: {
  readonly rowId: string;
  readonly persistentMessageId: string;
  readonly turnMessageIds: ReadonlyArray<string> | null;
  readonly markdown: string;
  readonly createdAt: number;
  readonly streaming: boolean;
}): ChatMessageModel {
  return {
    ...makeMessageAt(0, "assistant", input.createdAt),
    id: input.rowId,
    persistentMessageId: input.persistentMessageId,
    ...(input.turnMessageIds === null
      ? {}
      : { turnMessageIds: input.turnMessageIds }),
    runState: input.streaming ? "running" : null,
    segments: [
      {
        id: `${input.rowId}:text`,
        kind: "text",
        markdown: input.markdown,
        isStreaming: input.streaming,
      },
    ],
  };
}

interface RowSpec {
  readonly rowId: string;
  /** The skeleton's placement key: a turn's anchor for its rows. */
  readonly createdAt: number;
  readonly role: "user" | "assistant";
  /** What the row's serve carries into the ledger. */
  readonly records: ReadonlyArray<Message>;
  /** The rendered row once hydrated; `null` leaves the row unhydrated. */
  readonly model: ChatMessageModel | null;
}

interface TranscriptState {
  readonly window: TranscriptWindow;
  /** What the list renders: hydrated rows, then live ones. */
  readonly messages: ReadonlyArray<ChatMessageModel>;
}

/**
 * A window the way the session builds one: a snapshot, the whole skeleton,
 * then one range serve per run of hydrated rows. `live` records arrive on the
 * stream, ahead of any ordinal.
 */
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
// The host.

interface FakeDoc {
  readonly messageId: string;
  readonly tier: ChatSearchTier;
  readonly createdAt: number;
  readonly text: string;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * A chat-scoped `substring` index over `docs`: ASCII-folded `LIKE`, newest
 * first, decimal-offset cursors, the page in `messageMatches[0].messages`.
 */
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
      // The common state while anything on the host is unindexed; it must not
      // read as an incomplete answer.
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

function searchCalls(
  messenger: MockHostMessenger<HostRpcRegistry>,
): ReadonlyArray<ChatSearchRequest> {
  return messenger.calls
    .filter((call) => call.method === "chat.search")
    .map((call) => chatSearchRequestSchema.parse(call.params));
}

/** The queries of every `chat.search` request that ended aborted, in order. */
function abortedSearchQueries(
  messenger: MockHostMessenger<HostRpcRegistry>,
): ReadonlyArray<string> {
  const queryByRequestId = new Map(
    messenger.calls
      .filter((call) => call.method === "chat.search")
      .map((call) => [
        call.requestId,
        chatSearchRequestSchema.parse(call.params).query,
      ]),
  );
  return messenger.phases.flatMap((phase) =>
    phase.kind === "response" && phase.error instanceof HostRequestAbortedError
      ? [queryByRequestId.get(phase.requestId) ?? "?"]
      : [],
  );
}

/** Lets query-layer work that is already due finish, so an absence is real. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

// ---------------------------------------------------------------------------
// The tile: `ChatMessages`' find wiring over the window.

interface ControllerHandle {
  readonly onTranscriptLandingSettled: (
    rowMessageId: string,
    outcome: "landed" | "exhausted" | "cancelled",
  ) => void;
  readonly onIndexReadFailed: (messageId: string) => void;
}

function renderFind(input: {
  readonly initial: TranscriptState;
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly scroller: HTMLElement;
  readonly requestIndexJump: Mock<(messageId: string) => void>;
  readonly requestIndexRead: Mock<(read: ChatFindIndexRead | null) => void>;
}): {
  readonly getAdapter: () => ChatFindAdapter;
  readonly getController: () => ControllerHandle;
  readonly setTranscript: (next: TranscriptState) => void;
  /** The list scroll every find REVEAL issues - a navigation's mechanism. */
  readonly scrollToLocation: Mock;
} {
  let registered: ChatFindAdapter | null = null;
  let controller: ControllerHandle | null = null;
  const tileFindContext = {
    tileInstanceId: TILE_INSTANCE_ID,
    registerAdapter: (adapter: TileFindAdapter) => {
      // Only ever the controller's own ChatFindAdapter.
      registered = adapter as ChatFindAdapter;
      return () => {
        if (registered === adapter) registered = null;
      };
    },
  };
  const forceStore = createChatFindForceStore();
  // `ChatMessages`' reader-navigation generation: find's own scroll bumps it
  // too, as in the app.
  let navigationGeneration = 0;
  const callbacks = {
    scrollToLocation: vi.fn(),
    cancelManualNavigation: vi.fn(() => {
      navigationGeneration += 1;
    }),
    setScrolledActiveUserMessageIdIfChanged: vi.fn(),
  };
  const getScroller = (): HTMLElement => input.scroller;

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
    // Stable identities, as `ChatMessages` passes them: the controller
    // registers its adapter against these.
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
      getNavigationGeneration: () => navigationGeneration,
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

  function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={input.queryClient}>
        <ChatFindForceTileInstanceIdContext.Provider value={TILE_INSTANCE_ID}>
          <ChatFindForceStoreContext.Provider value={forceStore}>
            <TileFindContext.Provider value={tileFindContext}>
              {props.children}
            </TileFindContext.Provider>
          </ChatFindForceStoreContext.Provider>
        </ChatFindForceTileInstanceIdContext.Provider>
      </QueryClientProvider>
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
      rendered.rerender(<Harness transcript={next} />);
    },
    scrollToLocation: callbacks.scrollToLocation,
  };
}

// ---------------------------------------------------------------------------
// Painting.

/** Mounts `message` the way the list renders it: a row with its find units. */
function mountRow(scroller: HTMLElement, message: ChatMessageModel): string {
  const [row] = buildChatFindRows([message], TILE_INSTANCE_ID, EMPTY_PROMOTED, {
    hideReasoning: false,
    queuePauseReasonProtocolSupported: null,
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

function activeHighlightText(
  values: ReadonlyMap<string, TestHighlight>,
): string | undefined {
  const active = [...values.entries()].find(([name]) =>
    name.includes("active"),
  );
  return active?.[1].ranges[0]?.toString();
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
    // Frames scheduled while flushing run too; `frames` only grows, so the
    // index walk reaches them.
    for (let index = 0; index < frames.length; index += 1) {
      frames[index](performance.now());
      frames[index] = () => undefined;
    }
  });
}

describe("chat find over a windowed transcript: older rows from the index", () => {
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

  const OLD_TEXT = "an old needle in the haystack";
  const NEW_TEXT = "a recent needle";

  /** An older user row, unhydrated, above a hydrated recent one. */
  function oldAndNew(oldHydrated: boolean): TranscriptState {
    return transcriptOf(
      [
        userSpec("u-old", 10, OLD_TEXT, oldHydrated),
        userSpec("u-new", 100, NEW_TEXT, true),
      ],
      null,
    );
  }

  it("reports one older index match, and navigating to it hydrates the row and highlights the exact range", async () => {
    const highlights = installMockHighlights();
    const host = hostFixture(
      fakeIndex([
        { messageId: "u-old", tier: "user", createdAt: 10, text: OLD_TEXT },
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: oldAndNew(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    // The client scan answers at once; the index answers after.
    expect(adapter.getSnapshot()).toMatchObject({
      total: 1,
      current: 1,
      coverageMessage: "Partial results: 1 older message is not loaded.",
    });
    await waitFor(() => {
      // NEW CONTRACT: the older hit is a CANDIDATE - never in `total` - until
      // stepping onto it reads the row.
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // Transcript order: the older index hit precedes the loaded match, and
    // the active match stays on the loaded one it was revealing.
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
    });
    // No date bound: none a client can derive is safe.
    expect(searchCalls(host.messenger).at(-1)?.dateRange).toBeNull();

    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenCalledWith({
      messageId: "u-old",
      target: "u-old",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      coverageMessage: CAVEAT_CHECKING,
    });

    // The read hydrates the row: it is now held and rendered, so the client
    // scan owns it and the candidate is CONFIRMED into a real, counted stop.
    // Mounted BEFORE `setTranscript` - unlike the old jump flow, a read's
    // confirmation reveals the match the INSTANT hydration lands, with no
    // landing signal to delay it until the row is on screen, so the row must
    // already be there for the reveal to find it.
    const hydrated = oldAndNew(true);
    const unitId = mountRow(scroller, hydrated.messages[0]);
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 2,
      coverageMessage: null,
    });
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();
    // A landing signal after the fact (as a real transcript still sends one)
    // is a safe no-op for a read-confirmed match: there is no pending jump
    // for it to answer.
    act(() => {
      find.getController().onTranscriptLandingSettled("u-old", "landed");
    });
    flushFrames();

    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 2,
      activeUnitId: unitId,
      exactHighlight: "painted",
    });
    expect(activeHighlightText(highlights.values)).toBe("needle");
    highlights.restore();
  });

  it("does not double count a hit inside the hydrated window, or one message's several tiers", async () => {
    const host = hostFixture(
      fakeIndex([
        { messageId: "u-new", tier: "user", createdAt: 100, text: NEW_TEXT },
        {
          messageId: "a-old",
          tier: "assistant",
          createdAt: 20,
          text: "prose needle",
        },
        {
          messageId: "a-old",
          tier: "card",
          createdAt: 20,
          text: "rg needle src",
        },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          userSpec("u-0", 5, "no match", false),
          {
            rowId: "assistant:t-old",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-old", "t-old", 20)],
            model: null,
          },
          userSpec("u-mid", 50, "no match", false),
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // ONE older candidate message across its three documents, not three -
    // still uncounted (never loaded/read), so total is just the loaded match.
    expect(adapter.getSnapshot()).toMatchObject({ total: 1 });
  });

  it("keeps today's caveat and count when the index refuses", async () => {
    const host = hostFixture(() => {
      throw new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "chat.search is not supported",
        requestId: "req-1",
        method: "chat.search",
        fatalDetails: null,
      });
    });
    const find = renderFind({
      initial: oldAndNew(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(1);
    });
    // Let the refusal settle through the query layer before reading.
    await act(async () => {
      await Promise.resolve();
    });
    expect(adapter.getSnapshot()).toMatchObject({
      total: 1,
      current: 1,
      coverageMessage: "Partial results: 1 older message is not loaded.",
      errorMessage: null,
    });
  });

  it("finds a live streaming row with the client scan before the index has it", async () => {
    const live = assistantRow({
      rowId: "assistant:turn-live",
      persistentMessageId: "a-live",
      turnMessageIds: null,
      markdown: "still streaming the needle",
      createdAt: 200,
      streaming: true,
    });
    // The index lags a live chat: the streaming row is not in it yet.
    const host = hostFixture(
      fakeIndex([
        { messageId: "u-old", tier: "user", createdAt: 10, text: OLD_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          userSpec("u-old", 10, OLD_TEXT, false),
          userSpec("u-new", 100, NEW_TEXT, true),
        ],
        {
          records: [assistantRecord("a-live", "turn-live", 200)],
          models: [live],
        },
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    expect(adapter.getSnapshot().total).toBe(2);
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // The older hit is still an uncounted candidate: the two LOADED matches
    // (the live streaming row and "u-new") are the whole count.
    expect(adapter.getSnapshot().total).toBe(2);
  });

  it("does not claim a match in older tool output, and the caveat names the exclusion", async () => {
    // Two older rows contain the needle: a user prompt, and an assistant turn
    // whose ONLY occurrence is in a tool's output. The host indexes the prompt
    // and the assistant's prose; tool output is never a document.
    const host = hostFixture(
      fakeIndex([
        { messageId: "u-old", tier: "user", createdAt: 10, text: OLD_TEXT },
        {
          messageId: "a-tool",
          tier: "assistant",
          createdAt: 30,
          text: "Ran the search.",
        },
        {
          messageId: "a-tool",
          tier: "card",
          createdAt: 30,
          text: "rg haystack",
        },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          userSpec("u-old", 10, OLD_TEXT, false),
          {
            rowId: "assistant:t-tool",
            createdAt: 30,
            role: "assistant",
            records: [assistantRecord("a-tool", "t-tool", 30)],
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // The tool-output-only row never became a candidate at all (never
    // indexed); the OTHER older row ("u-old") is a candidate, uncounted.
    expect(adapter.getSnapshot().total).toBe(1);
  });

  /** `count` older user rows, unhydrated, under one hydrated recent row. */
  function pagedTranscript(count: number): TranscriptState {
    return transcriptOf(
      [
        ...Array.from({ length: count }, (_unused, index) =>
          userSpec(`u-${index}`, index + 1, `needle ${index}`, false),
        ),
        userSpec("u-new", 1000, NEW_TEXT, true),
      ],
      null,
    );
  }

  function pagedDocs(count: number): FakeDoc[] {
    return Array.from({ length: count }, (_unused, index) => ({
      messageId: `u-${index}`,
      tier: "user",
      createdAt: index + 1,
      text: `needle ${index}`,
    }));
  }

  it("asks for page 1 per query and a further page only on navigating past the oldest loaded hit", async () => {
    // Three pages of older hits, newest first: u-249..u-150, u-149..u-50,
    // u-49..u-0. Under the NEW contract every one of them is an uncounted
    // CANDIDATE until read - this cell adapts by reading (and failing) each
    // one in turn, the same mechanism F14-12 in chat-find-index-confirm.test.tsx
    // proves: a failed read hands the step to the NEXT older candidate
    // automatically, so walking off the end of a page is still what triggers
    // the next page fetch, unchanged from the original intent.
    const host = hostFixture(fakeIndex(pagedDocs(250)));
    const find = renderFind({
      initial: pagedTranscript(250),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        CAVEAT_MAY_MATCH_AT_LEAST(100),
      );
    });
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(1);
    // NEW CONTRACT: page 1's 100 hits are uncounted candidates - only the
    // loaded match counts.
    expect(adapter.getSnapshot().total).toBe(1);

    // Step onto the newest older candidate: read, not jumped to.
    act(() => {
      void adapter.previous();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "u-249",
      target: "u-249",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();

    // Fail every page-1 candidate in turn, oldest-ward: each failure hands
    // the step to the next one automatically.
    for (let index = 249; index >= 150; index -= 1) {
      const messageId = `u-${index}`;
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId,
        target: messageId,
      });
      act(() => {
        find.getController().onIndexReadFailed(messageId);
      });
    }

    // Past the oldest hit of page 1: the next page is fetched, and the walk
    // continues into it rather than wrapping to the loaded match.
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(2);
    });
    expect(
      searchCalls(host.messenger).map((call) => call.messageCursor),
    ).toEqual([null, "100"]);
    // The walk continues straight into the new page's newest candidate - it
    // is now being read (checking), not yet counted or wrapped past.
    await waitFor(() => {
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "u-149",
        target: "u-149",
      });
    });
    expect(requestIndexJump).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_CHECKING);

    // Cancelling the in-flight read (the opposite direction) and stepping
    // forward again never asks for another page.
    act(() => {
      void adapter.next();
    });
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(2);
  });

  it("drops 'At least' once the last page is seen", async () => {
    // 150 across exactly two pages (100 + 50): once page 2 lands there is no
    // `more` cursor left, so the caveat drops "At least" - a pagination fact,
    // independent of whether any candidate has been read/confirmed yet.
    const host = hostFixture(fakeIndex(pagedDocs(150)));
    const find = renderFind({
      initial: pagedTranscript(150),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        CAVEAT_MAY_MATCH_AT_LEAST(100),
      );
    });
    expect(adapter.getSnapshot().total).toBe(1);

    // Read (and fail) every page-1 candidate, oldest-ward, to walk off the
    // end of page 1 - same mechanism as the sibling pagination cell above.
    act(() => {
      void adapter.previous();
    });
    for (let index = 149; index >= 50; index -= 1) {
      const messageId = `u-${index}`;
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId,
        target: messageId,
      });
      act(() => {
        find.getController().onIndexReadFailed(messageId);
      });
    }

    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(2);
    });
    // The walk carries straight on into page 2's newest candidate - fail
    // every one of ITS hits too, oldest-ward, until nothing remains to read.
    await waitFor(() => {
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "u-49",
        target: "u-49",
      });
    });
    for (let index = 49; index >= 0; index -= 1) {
      const messageId = `u-${index}`;
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId,
        target: messageId,
      });
      act(() => {
        find.getController().onIndexReadFailed(messageId);
      });
    }

    // Every one of the 150 hits failed to confirm, and there is nowhere
    // older left to read: the walk wraps to the one loaded match, and the
    // read ends.
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({ current: 1, total: 1 });
    // Page 2 was the LAST page (150 total, no cursor left): "At least" drops
    // from the caveat even though every hit only FAILED - none is confirmed,
    // so `total` still names just the one loaded match.
    expect(adapter.getSnapshot().coverageMessage).toBe(
      CAVEAT_MAY_MATCH_MANY(150),
    );

    // No further page is ever asked for.
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(2);
  });

  it("cancels an in-flight page request when the query changes or the bar closes", async () => {
    const serve = fakeIndex([
      {
        messageId: "u-old",
        tier: "user",
        createdAt: 10,
        text: "needle haystack",
      },
    ]);
    // "needle" and "needle hay" never answer on their own; the abort is the
    // only way their requests end.
    const host = hostFixture(async (params) => {
      if (params.query !== "needle haystack") {
        await new Promise<never>(() => undefined);
      }
      return serve(params);
    });
    const find = renderFind({
      initial: oldAndNew(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(1);
    });
    // A longer query settles while the first request is still in flight.
    act(() => {
      void adapter.search({
        requestId: 2,
        query: "needle haystack",
        matchCase: false,
      });
    });
    await waitFor(() => {
      expect(abortedSearchQueries(host.messenger)).toEqual(["needle"]);
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // "needle haystack" matches nothing loaded ("u-new" only has "a recent
    // needle"), and the one hit is an uncounted candidate: no counted stop
    // at all yet.
    expect(adapter.getSnapshot()).toMatchObject({ total: 0, current: 0 });

    // Closing the bar ends an in-flight request the same way.
    act(() => {
      void adapter.search({
        requestId: 3,
        query: "needle hay",
        matchCase: false,
      });
    });
    await waitFor(() => {
      expect(
        searchCalls(host.messenger).filter(
          (call) => call.query === "needle hay",
        ),
      ).toHaveLength(1);
    });
    act(() => {
      adapter.clear();
    });
    await waitFor(() => {
      expect(abortedSearchQueries(host.messenger)).toEqual([
        "needle",
        "needle hay",
      ]);
    });
  });

  /**
   * No client-side date bound is safe. A turn adopted from a notification
   * keeps the notification's early transcript position while its records are
   * stamped at run time - later than rows that sort after it. A bound taken
   * from the hydrated rows excluded exactly those records.
   */
  it("finds an older record stamped later than the hydrated rows below it", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-adopted",
          tier: "assistant",
          createdAt: 50,
          text: "the adopted turn found the needle",
        },
        { messageId: "u-new", tier: "user", createdAt: 30, text: NEW_TEXT },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          {
            rowId: "assistant:t-adopted",
            // The notification's time, which is where the row stays.
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-adopted", "t-adopted", 50)],
            model: null,
          },
          userSpec("u-new", 30, NEW_TEXT, true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // The adopted turn is still an uncounted candidate; only "u-new" counts.
    expect(adapter.getSnapshot().total).toBe(1);
  });

  it("reads past a page of loaded matches when the reader steps back from the oldest one", async () => {
    // The newest 100 documents are all rows the tile holds, so page 1 names
    // no older message; the one older match is on page 2.
    const tail = Array.from({ length: 100 }, (_unused, index) =>
      userSpec(`u-t${index}`, 10 + index, `tail needle ${index}`, true),
    );
    const host = hostFixture(
      fakeIndex([
        { messageId: "u-old", tier: "user", createdAt: 1, text: OLD_TEXT },
        ...tail.map((row, index) => ({
          messageId: row.rowId,
          tier: "user" as const,
          createdAt: row.createdAt,
          text: `tail needle ${index}`,
        })),
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [userSpec("u-old", 1, OLD_TEXT, false), ...tail],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(1);
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 100,
      coverageMessage: "Partial results: 1 older message is not loaded.",
    });

    // Back from the oldest loaded match: the next page, and onto what it
    // names instead of wrapping to the newest match.
    act(() => {
      void adapter.previous();
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(2);
    });
    // The new page's one hit is read, not jumped to - and still uncounted
    // while the read is outstanding.
    await waitFor(() => {
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "u-old",
        target: "u-old",
      });
    });
    expect(requestIndexJump).not.toHaveBeenCalled();
    expect(adapter.getSnapshot()).toMatchObject({
      total: 100,
      coverageMessage: CAVEAT_CHECKING,
    });
  });

  /**
   * A turn whose hydration edge falls inside it: one slice is hydrated, so
   * the window holds all of the turn's records, but the text of the others is
   * nowhere the client scan can see.
   */
  function straddledTurn(input: {
    readonly hydratedParts: ReadonlySet<number>;
    readonly partText: (part: number) => string;
  }): TranscriptState {
    const record = assistantRecord("a-T", "T", 21);
    return transcriptOf(
      [
        ...[0, 1, 2].map((part): RowSpec => ({
          rowId: `assistant:T:part:${part}`,
          createdAt: 20,
          role: "assistant",
          records: [record],
          model: input.hydratedParts.has(part)
            ? assistantRow({
                rowId: `assistant:T:part:${part}`,
                persistentMessageId: "a-T",
                turnMessageIds: null,
                markdown: input.partText(part),
                createdAt: 20,
                streaming: false,
              })
            : null,
        })),
        userSpec("u-new", 100, "a recent note", true),
      ],
      null,
    );
  }

  it("walks a held turn's placeholders nearest its hydrated slice first when that slice comes BEFORE them", async () => {
    const partText = (part: number): string =>
      part === 1 ? "the middle slice has the needle" : `slice ${part}`;
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: "the middle slice has the needle",
        },
      ]),
    );
    // Slice 0 hydrated, as a jump or a scroll down from one leaves it: the
    // placeholders sit AFTER the hydrated part, so the nearest is part 1.
    const find = renderFind({
      initial: straddledTurn({ hydratedParts: new Set([0]), partText }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();
    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    expect(adapter.getSnapshot().total).toBe(0);
    act(() => {
      void adapter.next();
    });
    // Reads the nearest unhydrated slice first, by its row id - same target a
    // jump used to use, now as a `requestIndexRead`.
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:1",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();
  });

  it("counts a held message whose match is in its unhydrated rows, and walks to it by row", async () => {
    const highlights = installMockHighlights();
    const partText = (part: number): string =>
      part === 1 ? "the middle slice has the needle" : `slice ${part}`;
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: "the middle slice has the needle",
        },
      ]),
    );
    const find = renderFind({
      initial: straddledTurn({ hydratedParts: new Set([2]), partText }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    expect(adapter.getSnapshot().total).toBe(0);

    // The nearest unhydrated slice first, by its row id - read, not jumped to.
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:1",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();

    const hydrated = straddledTurn({
      hydratedParts: new Set([1, 2]),
      partText,
    });
    act(() => {
      find.setTranscript(hydrated);
    });
    // The hydrated slice confirms the candidate into a real, counted stop -
    // the same hydration alone drives the confirmation, without waiting on a
    // landing signal.
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);

    const unitId = mountRow(scroller, hydrated.messages[0]);
    act(() => {
      find
        .getController()
        .onTranscriptLandingSettled("assistant:T:part:1", "landed");
    });
    flushFrames();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: unitId,
      exactHighlight: "painted",
    });
    expect(activeHighlightText(highlights.values)).toBe("needle");
    highlights.restore();
  });

  it("walks on to the next unhydrated row when the landed one does not hold the match", async () => {
    const partText = (part: number): string =>
      part === 0 ? "the first slice has the needle" : `slice ${part}`;
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: "the first slice has the needle",
        },
      ]),
    );
    const find = renderFind({
      initial: straddledTurn({ hydratedParts: new Set([2]), partText }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    expect(adapter.getSnapshot().total).toBe(0);
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:1",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();

    // Slice 1 lands without the text: the hydration alone hands the read on
    // to slice 0, with no landing signal needed at all - reading reacts to
    // hydration directly.
    act(() => {
      find.setTranscript(
        straddledTurn({ hydratedParts: new Set([1, 2]), partText }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:0",
    });

    const hydrated = straddledTurn({
      hydratedParts: new Set([0, 1, 2]),
      partText,
    });
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
    const unitId = mountRow(scroller, hydrated.messages[0]);
    act(() => {
      find
        .getController()
        .onTranscriptLandingSettled("assistant:T:part:0", "landed");
    });
    flushFrames();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: unitId,
    });
  });

  it("hands an earlier record of a folded turn to the client scan once its row lands", async () => {
    const highlights = installMockHighlights();
    const records = [
      assistantRecord("a-first", "T2", 20),
      assistantRecord("a-last", "T2", 21),
    ];
    const foldedTurn = (hydrated: boolean): TranscriptState =>
      transcriptOf(
        [
          {
            rowId: "assistant:T2",
            createdAt: 20,
            role: "assistant",
            records,
            model: hydrated
              ? assistantRow({
                  rowId: "assistant:T2",
                  // The row renders under its LAST record.
                  persistentMessageId: "a-last",
                  turnMessageIds: ["a-first", "a-last"],
                  markdown: "the first record's needle",
                  createdAt: 20,
                  streaming: false,
                })
              : null,
          },
          userSpec("u-new", 100, "a recent note", true),
        ],
        null,
      );
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-first",
          tier: "assistant",
          createdAt: 20,
          text: "the first record's needle",
        },
      ]),
    );
    const find = renderFind({
      initial: foldedTurn(false),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    expect(adapter.getSnapshot().total).toBe(0);
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-first",
      target: "a-first",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();

    // Mounted BEFORE `setTranscript`: the confirmation reveals the exact
    // match - the row renders under the turn's LAST record, and the hit
    // named the first - the instant hydration lands, so the row must
    // already be there for the reveal to find it.
    const hydrated = foldedTurn(true);
    const unitId = mountRow(scroller, hydrated.messages[0]);
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();
    // A landing signal after the fact is a safe no-op: there is no pending
    // jump for it to answer.
    act(() => {
      find.getController().onTranscriptLandingSettled("assistant:T2", "landed");
    });
    flushFrames();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: unitId,
      exactHighlight: "painted",
    });
    expect(activeHighlightText(highlights.values)).toBe("needle");
    highlights.restore();
  });

  /**
   * A steer bubble sits at its turn's start while its record carries the
   * time it was sent. Its row id IS the record id, so the skeleton places it
   * exactly; the timestamp would put it after rows it precedes.
   */
  it("places a steer hit where its row is, not where its timestamp falls", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "s-steer",
          tier: "user",
          createdAt: 35,
          text: "steer toward the needle",
        },
      ]),
    );
    const find = renderFind({
      initial: transcriptOf(
        [
          userSpec("u-1", 10, "needle one", true),
          {
            rowId: "assistant:T",
            createdAt: 20,
            role: "assistant",
            records: [assistantRecord("a-T", "T", 20)],
            model: null,
          },
          {
            rowId: "s-steer",
            createdAt: 20,
            role: "user",
            records: [userRecord("s-steer", 35)],
            model: null,
          },
          userSpec("u-3", 30, "needle three", true),
        ],
        null,
      ),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    // The steer hit is still an uncounted candidate: only the two LOADED
    // matches ("needle one", "needle three") count.
    expect(adapter.getSnapshot()).toMatchObject({ total: 2, current: 1 });
    // From "needle one" the next stop is the steer, before "needle three" -
    // read (by its row id, which is its own messageId), not jumped to.
    act(() => {
      void adapter.next();
    });
    expect(adapter.getSnapshot().current).toBe(1);
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "s-steer",
      target: "s-steer",
    });
    expect(requestIndexJump).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Reviewer item 1: with NO loaded match, running out of page 1 must still
  // read page 2 - whether page 1 ran out through failed reads or was dropped
  // whole by the scan.

  const REAL_OLD_TEXT = "an old needle that is real";

  /** Page 1: u-99..u-0 (createdAt 101..2). Page 2: the one real hit, u-real. */
  function pageTwoRealDocs(): FakeDoc[] {
    return [
      { messageId: "u-real", tier: "user", createdAt: 1, text: REAL_OLD_TEXT },
      ...Array.from({ length: 100 }, (_unused, index) => ({
        messageId: `u-${index}`,
        tier: "user" as const,
        createdAt: index + 2,
        text: `needle ${index}`,
      })),
    ];
  }

  /**
   * u-real above u-0..u-99. A hydrated phantom row paints text WITHOUT the
   * needle its index document claims.
   */
  function pageTwoRealTranscript(input: {
    readonly realHydrated: boolean;
    readonly phantomsHydrated: boolean;
  }): TranscriptState {
    return transcriptOf(
      [
        userSpec("u-real", 1, REAL_OLD_TEXT, input.realHydrated),
        ...Array.from({ length: 100 }, (_unused, index) =>
          userSpec(
            `u-${index}`,
            index + 2,
            `a phantom ${index}`,
            input.phantomsHydrated,
          ),
        ),
      ],
      null,
    );
  }

  it("item 1a: reads page 2 once every page-1 candidate fails and nothing is loaded", async () => {
    const host = hostFixture(fakeIndex(pageTwoRealDocs()));
    const find = renderFind({
      initial: pageTwoRealTranscript({
        realHydrated: false,
        phantomsHydrated: false,
      }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        CAVEAT_MAY_MATCH_AT_LEAST(100),
      );
    });
    expect(adapter.getSnapshot().total).toBe(0);

    act(() => {
      void adapter.previous();
    });
    for (let index = 99; index >= 0; index -= 1) {
      const messageId = `u-${index}`;
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId,
        target: messageId,
      });
      act(() => {
        find.getController().onIndexReadFailed(messageId);
      });
    }

    // Nothing older on page 1 and no loaded match to wrap to: the walk must
    // read page 2 rather than stall.
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "u-real",
        target: "u-real",
      });
    });

    act(() => {
      find.setTranscript(
        pageTwoRealTranscript({ realHydrated: true, phantomsHydrated: false }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({ total: 1, current: 1 });
  });

  it("item 1b: reads page 2 when the scan drops all of page 1 and nothing is loaded", async () => {
    const host = hostFixture(fakeIndex(pageTwoRealDocs()));
    const find = renderFind({
      initial: pageTwoRealTranscript({
        realHydrated: false,
        phantomsHydrated: true,
      }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(1);
    });
    await settle();
    // Every page-1 hit is a hydrated row that paints no needle: dropped on
    // arrival, so there is no candidate and nothing counted.
    expect(adapter.getSnapshot()).toMatchObject({
      total: 0,
      coverageMessage: "Partial results: 1 older message is not loaded.",
    });

    act(() => {
      void adapter.previous();
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(requestIndexRead).toHaveBeenLastCalledWith({
        messageId: "u-real",
        target: "u-real",
      });
    });

    act(() => {
      find.setTranscript(
        pageTwoRealTranscript({ realHydrated: true, phantomsHydrated: true }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot()).toMatchObject({ total: 1, current: 1 });
  });

  // -------------------------------------------------------------------------
  // Reviewer item 5: a `loaded` placement over a PARTIAL skeleton is not a
  // complete negative - the rows the skeleton has not named yet can hold the
  // match.

  /**
   * `transcriptOf`, but the skeleton names only the first `known` rows, in
   * one chunk that is final only when `isFinal`. Epoch 1 always, so two
   * windows built here are the SAME coordinate space.
   */
  function transcriptWithSkeleton(
    rows: ReadonlyArray<RowSpec>,
    known: number,
    isFinal: boolean,
  ): TranscriptState {
    return transcriptWithSkeletonFrom(rows, 0, known, isFinal);
  }

  /**
   * The same, but the one skeleton chunk names rows `[namedFrom, namedTo)` -
   * so a chunk can leave an EARLIER row unnamed.
   */
  function transcriptWithSkeletonFrom(
    rows: ReadonlyArray<RowSpec>,
    namedFrom: number,
    namedTo: number,
    isFinal: boolean,
  ): TranscriptState {
    return transcriptWithSkeletonChunks(
      rows,
      [{ from: namedFrom, to: namedTo }],
      isFinal,
    );
  }

  /**
   * The same over several chunks, applied in order - so a later chunk can
   * land beyond a hole a dropped one left. Only the last may be final.
   */
  function transcriptWithSkeletonChunks(
    rows: ReadonlyArray<RowSpec>,
    chunks: ReadonlyArray<{ readonly from: number; readonly to: number }>,
    isFinal: boolean,
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
    chunks.forEach((chunk, index) => {
      window = applySkeletonChunk(window, {
        epoch: 1,
        fromOrdinal: chunk.from,
        entries: rows.slice(chunk.from, chunk.to).map((row) => ({
          rowId: row.rowId,
          createdAt: row.createdAt,
          role: row.role,
          byteLength: 128,
          bodyDigest: `d-${row.rowId}`,
        })),
        isFinal: isFinal && index === chunks.length - 1,
      });
    });
    let ordinal = 0;
    while (ordinal < rows.length) {
      if (rows[ordinal].model === null) {
        ordinal += 1;
        continue;
      }
      const from = ordinal;
      while (ordinal < rows.length && rows[ordinal].model !== null)
        ordinal += 1;
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
    return {
      window,
      messages: rows.flatMap((row) => (row.model === null ? [] : [row.model])),
    };
  }

  const LATER_SLICE_TEXT = "the later slice has the needle";

  function turnPart(
    part: number,
    hydrated: boolean,
    markdown: string,
  ): RowSpec {
    const rowId = `assistant:T:part:${part}`;
    return {
      rowId,
      createdAt: 20,
      role: "assistant",
      records: [assistantRecord("a-T", "T", 21)],
      model: hydrated
        ? assistantRow({
            rowId,
            persistentMessageId: "a-T",
            turnMessageIds: null,
            markdown,
            createdAt: 20,
            streaming: false,
          })
        : null,
    };
  }

  /** Turn T in two slices: part:0 paints "slice 0", part:1 the needle. */
  function laterSliceTurn(input: {
    readonly complete: boolean;
    readonly hydratedParts: ReadonlySet<number>;
  }): TranscriptState {
    return transcriptWithSkeleton(
      [
        turnPart(0, input.hydratedParts.has(0), "slice 0"),
        turnPart(1, input.hydratedParts.has(1), LATER_SLICE_TEXT),
      ],
      input.complete ? 2 : 1,
      input.complete,
    );
  }

  it("item 5a: a hit dropped over a PARTIAL skeleton revives when the skeleton completes", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: LATER_SLICE_TEXT,
        },
      ]),
    );
    const find = renderFind({
      initial: laterSliceTurn({ complete: false, hydratedParts: new Set([0]) }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(1);
    });
    await settle();
    // The skeleton names only part:0, which is hydrated without the needle,
    // so the hit places `loaded` - but part:1 is simply not named yet.
    expect(adapter.getSnapshot()).toMatchObject({
      total: 0,
      coverageMessage: "Partial results: 1 older message is not loaded.",
    });

    // The rest of the skeleton lands in the SAME epoch, naming part:1 as an
    // unhydrated slice of the held turn.
    act(() => {
      find.setTranscript(
        laterSliceTurn({ complete: true, hydratedParts: new Set([0]) }),
      );
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);

    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:1",
    });

    act(() => {
      find.setTranscript(
        laterSliceTurn({ complete: true, hydratedParts: new Set([0, 1]) }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
  });

  it("item 5b (control): a hit dropped over a COMPLETE skeleton stays dropped after eviction", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: "the only slice has the needle",
        },
      ]),
    );
    // One slice of T, named by a complete skeleton, then an unhydrated user
    // row with no index document - there only so a row is unhydrated and the
    // index is asked at all.
    const singleSlice = (hydrated: boolean): TranscriptState =>
      transcriptWithSkeleton(
        [
          turnPart(0, hydrated, "slice 0"),
          userSpec("u-other", 100, "a recent note", false),
        ],
        2,
        true,
      );
    const find = renderFind({
      initial: singleSlice(true),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(1);
    });
    await settle();
    // Every slice of T is named and hydrated, and none paints the needle: a
    // true negative, dropped on the answer.
    expect(adapter.getSnapshot()).toMatchObject({
      total: 0,
      coverageMessage: "Partial results: 1 older message is not loaded.",
    });

    // Evicted: the drop is remembered, so the hit is not a candidate again.
    act(() => {
      find.setTranscript(singleSlice(false));
    });
    expect(adapter.getSnapshot().total).toBe(0);
    expect(adapter.getSnapshot().coverageMessage ?? "").not.toContain(
      "may match",
    );
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).not.toHaveBeenCalled();
  });

  it("item 5c (F19): the unnamed slice is EARLIER than the held tail - revives when the skeleton completes", async () => {
    const EARLIER_SLICE_TEXT = "the earlier slice has the needle";
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: EARLIER_SLICE_TEXT,
        },
      ]),
    );
    // T in three slices. part:1 and part:2 are hydrated without the needle,
    // so the window holds a-T through its TAIL; part:0 carries the needle and
    // stays unhydrated. `u-other` (no index document) keeps a row unhydrated
    // once the turn is whole.
    const earlierSliceTurn = (input: {
      readonly complete: boolean;
      readonly part0Hydrated: boolean;
    }): TranscriptState =>
      transcriptWithSkeletonFrom(
        [
          turnPart(0, input.part0Hydrated, EARLIER_SLICE_TEXT),
          turnPart(1, true, "slice 1"),
          turnPart(2, true, "slice 2"),
          userSpec("u-other", 100, "a recent note", false),
        ],
        // Partial: part:1 onward, leaving part:0 unnamed. Complete: all of it.
        input.complete ? 0 : 1,
        4,
        input.complete,
      );
    const find = renderFind({
      initial: earlierSliceTurn({ complete: false, part0Hydrated: false }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(searchCalls(host.messenger)).toHaveLength(1);
    });
    await settle();
    // No KNOWN slice of T is unhydrated, so the hit places `loaded` - and
    // part:0 is simply not named yet.
    expect(adapter.getSnapshot().total).toBe(0);
    expect(adapter.getSnapshot().coverageMessage ?? "").not.toContain(
      "may match",
    );

    // The skeleton completes from ordinal 0 in the SAME epoch, naming part:0
    // as an unhydrated slice of the held turn.
    act(() => {
      find.setTranscript(
        earlierSliceTurn({ complete: true, part0Hydrated: false }),
      );
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);

    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:0",
    });

    act(() => {
      find.setTranscript(
        earlierSliceTurn({ complete: true, part0Hydrated: true }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
  });

  // Over a partial skeleton a read that sees every NAMED slice without a
  // match concludes nothing. Under memory pressure the slices cannot all be
  // held at once, so reading them again would end the same way: the hit is
  // parked, still "may match", until the skeleton changes.
  const UNNAMED_SLICE_TEXT = "the unnamed slice has the needle";

  /**
   * T in four slices: part:0 and part:1 named and cold, part:2 hydrated (so
   * the record is held), part:3 unnamed until the skeleton completes and the
   * one holding the needle. `u-other` has no index document.
   */
  function pressuredTurn(input: {
    readonly complete: boolean;
    readonly hydratedParts: ReadonlySet<number>;
  }): TranscriptState {
    return transcriptWithSkeleton(
      [
        turnPart(0, input.hydratedParts.has(0), "slice 0"),
        turnPart(1, input.hydratedParts.has(1), "slice 1"),
        turnPart(2, input.hydratedParts.has(2), "slice 2"),
        turnPart(3, input.hydratedParts.has(3), UNNAMED_SLICE_TEXT),
        userSpec("u-other", 100, "a recent note", false),
      ],
      input.complete ? 5 : 3,
      input.complete,
    );
  }

  function readCount(): number {
    return requestIndexRead.mock.calls.filter(([read]) => read !== null).length;
  }

  it("parks a read that concludes nothing over a partial skeleton, and reads it again only once the skeleton changes", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: UNNAMED_SLICE_TEXT,
        },
      ]),
    );
    const find = renderFind({
      initial: pressuredTurn({ complete: false, hydratedParts: new Set([2]) }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });

    // The nearest named slice first, then the next.
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:1",
    });
    act(() => {
      find.setTranscript(
        pressuredTurn({ complete: false, hydratedParts: new Set([1, 2]) }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:0",
    });
    // part:0 lands and part:1 is evicted to make room: both seen, no match.
    act(() => {
      find.setTranscript(
        pressuredTurn({ complete: false, hydratedParts: new Set([0, 2]) }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(readCount()).toBe(2);
    // Still counted as "may match", never as a match.
    expect(adapter.getSnapshot()).toMatchObject({
      total: 0,
      coverageMessage: CAVEAT_MAY_MATCH_ONE,
    });

    // No read without a press, and a press does not re-enter it either.
    act(() => {
      find.setTranscript(
        pressuredTurn({ complete: false, hydratedParts: new Set([2]) }),
      );
    });
    act(() => {
      void adapter.next();
    });
    expect(readCount()).toBe(2);

    // The skeleton completes: part:3 is named, and the hit is a candidate
    // again - read, and confirmed where the needle really is.
    act(() => {
      find.setTranscript(
        pressuredTurn({ complete: true, hydratedParts: new Set([2]) }),
      );
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:3",
    });
    act(() => {
      find.setTranscript(
        pressuredTurn({ complete: true, hydratedParts: new Set([2, 3]) }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
  });

  // A dropped chunk leaves a hole the stream's prefix never gets past, so a
  // later chunk can name new rows while `rowCount`, the prefix and completeness
  // all stand still. A park is about the rows NAMED, so it has to see that.
  const BEYOND_GAP_TEXT = "the slice beyond the gap has the needle";

  /**
   * T in slices part:0 and part:1 (cold), part:2 (hydrated) and part:4 (the
   * needle), with `u-gap` at ordinal 3 - the ordinal a dropped chunk would have
   * named - and `u-other` (no index document) last.
   */
  function gappedTurn(input: {
    readonly chunks: ReadonlyArray<{
      readonly from: number;
      readonly to: number;
    }>;
    readonly hydratedParts: ReadonlySet<number>;
  }): TranscriptState {
    return transcriptWithSkeletonChunks(
      [
        turnPart(0, input.hydratedParts.has(0), "slice 0"),
        turnPart(1, input.hydratedParts.has(1), "slice 1"),
        turnPart(2, input.hydratedParts.has(2), "slice 2"),
        userSpec("u-gap", 50, "a note in the gap", false),
        turnPart(4, input.hydratedParts.has(4), BEYOND_GAP_TEXT),
        userSpec("u-other", 100, "a recent note", false),
      ],
      input.chunks,
      false,
    );
  }

  /** Reads part:1, then part:0 with part:1 evicted: parked, two reads. */
  async function parkedOverGap() {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "a-T",
          tier: "assistant",
          createdAt: 21,
          text: BEYOND_GAP_TEXT,
        },
      ]),
    );
    const firstChunk = [{ from: 0, to: 3 }];
    const find = renderFind({
      initial: gappedTurn({ chunks: firstChunk, hydratedParts: new Set([2]) }),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
      requestIndexRead,
    });
    const adapter = find.getAdapter();
    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
    });
    act(() => {
      void adapter.next();
    });
    act(() => {
      find.setTranscript(
        gappedTurn({ chunks: firstChunk, hydratedParts: new Set([1, 2]) }),
      );
    });
    act(() => {
      find.setTranscript(
        gappedTurn({ chunks: firstChunk, hydratedParts: new Set([0, 2]) }),
      );
    });
    // Precondition: parked, as the pressured-turn cell above pins.
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(readCount()).toBe(2);
    return { adapter, find };
  }

  it("reads a parked hit again once a chunk beyond a dropped one names a new slice of it", async () => {
    const { adapter, find } = await parkedOverGap();

    // Beyond the hole at ordinal 3: the prefix, `rowCount` and completeness
    // are all unchanged, but part:4 is named now.
    const beyondGap = [
      { from: 0, to: 3 },
      { from: 4, to: 6 },
    ];
    act(() => {
      find.setTranscript(
        gappedTurn({ chunks: beyondGap, hydratedParts: new Set([0, 2]) }),
      );
    });
    act(() => {
      void adapter.next();
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:1",
    });
    act(() => {
      find.setTranscript(
        gappedTurn({ chunks: beyondGap, hydratedParts: new Set([0, 1, 2]) }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith({
      messageId: "a-T",
      target: "assistant:T:part:4",
    });
    act(() => {
      find.setTranscript(
        gappedTurn({
          chunks: beyondGap,
          hydratedParts: new Set([0, 1, 2, 4]),
        }),
      );
    });
    expect(requestIndexRead).toHaveBeenLastCalledWith(null);
    expect(adapter.getSnapshot().total).toBe(1);
  });

  it("keeps the park through a chunk that names nothing new", async () => {
    const { adapter, find } = await parkedOverGap();

    // A chunk re-sending part:1 and part:2, off the prefix: no new name.
    act(() => {
      find.setTranscript(
        gappedTurn({
          chunks: [
            { from: 0, to: 3 },
            { from: 1, to: 3 },
          ],
          hydratedParts: new Set([0, 2]),
        }),
      );
    });
    act(() => {
      void adapter.next();
    });
    expect(readCount()).toBe(2);
    expect(adapter.getSnapshot().coverageMessage).toBe(CAVEAT_MAY_MATCH_ONE);
  });
});
