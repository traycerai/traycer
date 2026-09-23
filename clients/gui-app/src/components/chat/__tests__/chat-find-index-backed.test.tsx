/**
 * Cmd+F over a windowed transcript: loaded rows keep the exact client scan,
 * older unloaded rows are answered by the host's chat-scoped `substring`
 * search, and navigating to an index hit hands the hydrated row back to the
 * client scan for the exact highlight.
 *
 * Driven over the real controller, adapter, projection and highlighter, the
 * real index hook and host query layer, and a scripted host. The fake index
 * holds documents the way the host's extraction does: one per (message, tier)
 * for user text, assistant prose, notices and card text - never tool output,
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

interface FakeDoc {
  readonly messageId: string;
  readonly tier: ChatSearchTier;
  readonly createdAt: number;
  readonly text: string;
}

function userRow(id: string, content: string, createdAt: number) {
  return {
    ...makeMessageAt(0, "user", createdAt),
    id,
    content,
    persistentMessageId: id,
  } satisfies ChatMessageModel;
}

function streamingAssistantRow(
  rowId: string,
  recordId: string,
  markdown: string,
  createdAt: number,
): ChatMessageModel {
  return {
    ...makeMessageAt(0, "assistant", createdAt),
    id: rowId,
    persistentMessageId: recordId,
    runState: "streaming",
    segments: [
      { id: `${rowId}:text`, kind: "text", markdown, isStreaming: true },
    ],
  };
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

interface TranscriptState {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  /** Record ids the window holds, hydrated or live. */
  readonly held: ReadonlySet<string>;
  readonly unhydratedRows: number;
  /** `dateRange.to` the renderer derives from the hydrated tail suffix. */
  readonly olderThan: number | null;
}

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
    const heldRef = useRef(transcript.held);
    heldRef.current = transcript.held;
    const unhydratedRef = useRef(transcript.unhydratedRows);
    unhydratedRef.current = transcript.unhydratedRows;
    const rowIndexByKeyRef = useRef<ReadonlyMap<string, number>>(new Map());
    rowIndexByKeyRef.current = new Map(
      transcript.messages.map((message, index) => [message.id, index]),
    );
    const backgroundToolBlockIdsRef = useRef(EMPTY_PROMOTED);
    // Stable identities, as `ChatMessages` passes them: the controller
    // registers its adapter against these.
    const getFindCoverageMessage = useCallback(
      () => chatFindCoverageMessage(unhydratedRef.current),
      [],
    );
    const isRecordHeld = useCallback(
      (messageId: string) => heldRef.current.has(messageId),
      [],
    );
    const find = useChatFindController({
      instanceId: TILE_INSTANCE_ID,
      messages: transcript.messages,
      messagesRef,
      backgroundToolBlockIds: EMPTY_PROMOTED,
      backgroundToolBlockIdsRef,
      getFindCoverageMessage,
      isRecordHeld,
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
      hasUnhydratedRows: transcript.unhydratedRows > 0,
      olderThan: transcript.olderThan,
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
  };
}

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

  const oldUser = userRow("u-old", "an old needle in the haystack", 10);
  const newUser = userRow("u-new", "a recent needle", 100);
  // Newer than every paged fixture's documents, so the bound admits them all.
  const latestUser = userRow("u-new", "a recent needle", 1000);

  it("reports one older index match, and navigating to it hydrates the row and highlights the exact range", async () => {
    const highlights = installMockHighlights();
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "u-old",
          tier: "user",
          createdAt: 10,
          text: oldUser.content,
        },
        {
          messageId: "u-new",
          tier: "user",
          createdAt: 100,
          text: newUser.content,
        },
      ]),
    );
    const find = renderFind({
      initial: {
        messages: [newUser],
        held: new Set(["u-new"]),
        unhydratedRows: 1,
        olderThan: 100,
      },
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
    // Only rows older than the hydrated tail are asked about.
    expect(searchCalls(host.messenger).at(-1)?.dateRange).toEqual({
      from: null,
      to: 100,
    });

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
    act(() => {
      find.setTranscript({
        messages: [oldUser, newUser],
        held: new Set(["u-old", "u-new"]),
        unhydratedRows: 0,
        olderThan: null,
      });
    });
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 2,
      coverageMessage: null,
    });

    const unitId = mountRow(scroller, oldUser);
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
    const active = [...highlights.values.entries()].find(([name]) =>
      name.includes("active"),
    );
    expect(active?.[1].ranges[0]?.toString()).toBe("needle");
    highlights.restore();
  });

  it("does not double count a hit inside the hydrated window, or one message's several tiers", async () => {
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "u-new",
          tier: "user",
          createdAt: 100,
          text: newUser.content,
        },
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
      initial: {
        messages: [newUser],
        held: new Set(["u-new"]),
        unhydratedRows: 3,
        // No bound: the in-window document comes back and must be dropped.
        olderThan: null,
      },
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
      initial: {
        messages: [newUser],
        held: new Set(["u-new"]),
        unhydratedRows: 1,
        olderThan: 100,
      },
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
    const live = streamingAssistantRow(
      "assistant:turn-live",
      "a-live",
      "still streaming the needle",
      200,
    );
    // The index lags a live chat: the streaming row is not in it yet.
    const host = hostFixture(
      fakeIndex([
        {
          messageId: "u-old",
          tier: "user",
          createdAt: 10,
          text: oldUser.content,
        },
      ]),
    );
    const find = renderFind({
      initial: {
        messages: [newUser, live],
        held: new Set(["u-new", "a-live"]),
        unhydratedRows: 1,
        olderThan: 100,
      },
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
        {
          messageId: "u-old",
          tier: "user",
          createdAt: 10,
          text: oldUser.content,
        },
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
      initial: {
        messages: [newUser],
        held: new Set(["u-new"]),
        unhydratedRows: 2,
        olderThan: 100,
      },
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

  it("asks for page 1 per query and a further page only on navigating past the oldest loaded hit", async () => {
    // Three pages of older hits, newest first: u-249..u-150, u-149..u-50,
    // u-49..u-0.
    const docs: FakeDoc[] = Array.from({ length: 250 }, (_unused, index) => ({
      messageId: `u-${index}`,
      tier: "user",
      createdAt: index + 1,
      text: `needle ${index}`,
    }));
    const host = hostFixture(fakeIndex(docs));
    const find = renderFind({
      initial: {
        messages: [latestUser],
        held: new Set(["u-new"]),
        unhydratedRows: 250,
        olderThan: 1000,
      },
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
    const docs: FakeDoc[] = Array.from({ length: 150 }, (_unused, index) => ({
      messageId: `u-${index}`,
      tier: "user",
      createdAt: index + 1,
      text: `needle ${index}`,
    }));
    const host = hostFixture(fakeIndex(docs));
    const find = renderFind({
      initial: {
        messages: [latestUser],
        held: new Set(["u-new"]),
        unhydratedRows: 150,
        olderThan: 1000,
      },
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
      initial: {
        messages: [newUser],
        held: new Set(["u-new"]),
        unhydratedRows: 1,
        olderThan: 100,
      },
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
});
