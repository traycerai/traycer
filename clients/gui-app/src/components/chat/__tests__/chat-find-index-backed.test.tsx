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
import { useCallback, useRef, type ReactNode } from "react";
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
    runState: input.streaming ? "streaming" : null,
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
}

function renderFind(input: {
  readonly initial: TranscriptState;
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly scroller: HTMLElement;
  readonly requestIndexJump: Mock<(messageId: string) => void>;
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
  const callbacks = {
    scrollToLocation: vi.fn(),
    cancelManualNavigation: vi.fn(),
    setScrolledActiveUserMessageIdIfChanged: vi.fn(),
  };
  const getScroller = (): HTMLElement => input.scroller;

  function Harness(props: { readonly transcript: TranscriptState }) {
    const { transcript } = props;
    const messagesRef = useRef(transcript.messages);
    messagesRef.current = transcript.messages;
    const windowRef = useRef(transcript.window);
    windowRef.current = transcript.window;
    const rowIndexByKeyRef = useRef<ReadonlyMap<string, number>>(new Map());
    rowIndexByKeyRef.current = new Map(
      transcript.messages.map((message, index) => [message.id, index]),
    );
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
      rowIndexByKeyRef,
      getScroller,
      scrollToLocation: callbacks.scrollToLocation,
      cancelManualNavigation: callbacks.cancelManualNavigation,
      setScrolledActiveUserMessageIdIfChanged:
        callbacks.setScrolledActiveUserMessageIdIfChanged,
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
    controller = find;
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
  const [row] = buildChatFindRows([message], TILE_INSTANCE_ID, EMPTY_PROMOTED);
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

  beforeEach(() => {
    scroller = document.createElement("div");
    document.body.append(scroller);
    restoreFrames = installFrameQueue();
    requestIndexJump = vi.fn<(messageId: string) => void>();
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
      expect(adapter.getSnapshot().total).toBe(2);
    });
    // Transcript order: the older index hit precedes the loaded match, and
    // the active match stays on the loaded one it was revealing.
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      coverageMessage: `1 older message matches; ${EXCLUSION_TAIL}`,
    });
    // No date bound: none a client can derive is safe.
    expect(searchCalls(host.messenger).at(-1)?.dateRange).toBeNull();

    act(() => {
      void adapter.previous();
    });
    expect(requestIndexJump).toHaveBeenCalledWith("u-old");
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 2,
      activeUnitId: null,
      exactHighlight: "pending",
    });

    // The jump hydrates the row: it is now held and rendered, so the client
    // scan owns it and the index stop is gone.
    const hydrated = oldAndNew(true);
    act(() => {
      find.setTranscript(hydrated);
    });
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 2,
      coverageMessage: null,
    });

    const unitId = mountRow(scroller, hydrated.messages[0]);
    flushFrames();
    // The landing reveals the exact match: the scroll is its mechanism.
    find.scrollToLocation.mockClear();
    act(() => {
      find.getController().onTranscriptLandingSettled("u-old", "landed");
    });
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();

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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().coverageMessage).toBe(
        `1 older message matches; ${EXCLUSION_TAIL}`,
      );
    });
    // One loaded match plus ONE older message, not three documents.
    expect(adapter.getSnapshot()).toMatchObject({ total: 2 });
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    expect(adapter.getSnapshot().total).toBe(2);
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(3);
    });
    expect(adapter.getSnapshot()).toMatchObject({
      coverageMessage: `1 older message matches; ${EXCLUSION_TAIL}`,
    });
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(2);
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(
      `1 older message matches; ${EXCLUSION_TAIL}`,
    );
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
    // u-49..u-0.
    const host = hostFixture(fakeIndex(pagedDocs(250)));
    const find = renderFind({
      initial: pagedTranscript(250),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(1 + 100);
    });
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(1);
    expect(adapter.getSnapshot()).toMatchObject({
      current: 101,
      coverageMessage: `At least 100 older messages match; ${EXCLUSION_TAIL}`,
    });

    // Backward within the loaded hits: into the newest older hit and back to
    // the loaded match. Nothing is fetched.
    act(() => {
      void adapter.previous();
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("u-249");
    act(() => {
      void adapter.next();
    });
    // Wrapping forward lands on the oldest LOADED hit, still without a fetch.
    act(() => {
      void adapter.next();
    });
    expect(adapter.getSnapshot().current).toBe(1);
    expect(requestIndexJump).toHaveBeenLastCalledWith("u-150");
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(1);

    // Past the oldest loaded hit: the next page, and the walk continues into
    // it rather than wrapping.
    act(() => {
      void adapter.previous();
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(1 + 200);
    });
    expect(
      searchCalls(host.messenger).map((call) => call.messageCursor),
    ).toEqual([null, "100"]);
    expect(adapter.getSnapshot()).toMatchObject({
      current: 100,
      coverageMessage: `At least 200 older messages match; ${EXCLUSION_TAIL}`,
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("u-149");

    // Backward navigation inside what is loaded never asks again.
    act(() => {
      void adapter.next();
    });
    await settle();
    expect(searchCalls(host.messenger)).toHaveLength(2);
  });

  it("drops 'At least' once the last page is seen", async () => {
    const host = hostFixture(fakeIndex(pagedDocs(150)));
    const find = renderFind({
      initial: pagedTranscript(150),
      client: host.client,
      queryClient: host.queryClient,
      scroller,
      requestIndexJump,
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(1 + 100);
    });
    // To the oldest loaded hit, then past it.
    act(() => {
      void adapter.next();
    });
    act(() => {
      void adapter.previous();
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(1 + 150);
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(
      `150 older messages match; ${EXCLUSION_TAIL}`,
    );
    // At the end of the walk, past the oldest hit wraps like any find.
    act(() => {
      void adapter.previous();
    });
    act(() => {
      for (let step = 0; step < 50; step += 1) void adapter.previous();
    });
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
      expect(adapter.getSnapshot().total).toBe(1);
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(
      `1 older message matches; ${EXCLUSION_TAIL}`,
    );

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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(2);
    });
    expect(adapter.getSnapshot().coverageMessage).toBe(
      `1 older message matches; ${EXCLUSION_TAIL}`,
    );
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
      expect(adapter.getSnapshot().total).toBe(101);
    });
    expect(searchCalls(host.messenger)).toHaveLength(2);
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      coverageMessage: `1 older message matches; ${EXCLUSION_TAIL}`,
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("u-old");
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot()).toMatchObject({
        total: 1,
        coverageMessage: `1 older message matches; ${EXCLUSION_TAIL}`,
      });
    });

    // The nearest unhydrated slice first, by its row id.
    act(() => {
      void adapter.next();
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("assistant:T:part:1");

    const hydrated = straddledTurn({
      hydratedParts: new Set([1, 2]),
      partText,
    });
    act(() => {
      find.setTranscript(hydrated);
    });
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(1);
    });
    act(() => {
      void adapter.next();
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("assistant:T:part:1");

    // Slice 1 lands without the text: on to slice 0.
    act(() => {
      find.setTranscript(
        straddledTurn({ hydratedParts: new Set([1, 2]), partText }),
      );
    });
    act(() => {
      find
        .getController()
        .onTranscriptLandingSettled("assistant:T:part:1", "landed");
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("assistant:T:part:0");

    const hydrated = straddledTurn({
      hydratedParts: new Set([0, 1, 2]),
      partText,
    });
    act(() => {
      find.setTranscript(hydrated);
    });
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(1);
    });
    act(() => {
      void adapter.next();
    });
    expect(requestIndexJump).toHaveBeenLastCalledWith("a-first");

    const hydrated = foldedTurn(true);
    act(() => {
      find.setTranscript(hydrated);
    });
    const unitId = mountRow(scroller, hydrated.messages[0]);
    flushFrames();
    // The landing is what reveals the exact match: the row renders under the
    // turn's last record, and the hit named the first.
    find.scrollToLocation.mockClear();
    act(() => {
      find.getController().onTranscriptLandingSettled("assistant:T2", "landed");
    });
    flushFrames();
    expect(find.scrollToLocation).toHaveBeenCalled();
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
    });
    const adapter = find.getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    });
    await waitFor(() => {
      expect(adapter.getSnapshot().total).toBe(3);
    });
    expect(adapter.getSnapshot().current).toBe(1);
    // From "needle one" the next stop is the steer, before "needle three".
    act(() => {
      void adapter.next();
    });
    expect(adapter.getSnapshot().current).toBe(2);
    expect(requestIndexJump).toHaveBeenLastCalledWith("s-steer");
  });
});
