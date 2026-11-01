/**
 * A channel opened onto one post, again and again: each
 * visit lands the list on the post, the same post's second visit included.
 * Drives the REAL `BotChatTranscript` over a session store's messages into the
 * REAL `ChatMessages` and its list, and reads where a landing went the way a
 * person sees it: the row it lands on flashes. `ChatMessages` is passed
 * through untouched; only the requests it reports settled are recorded, so a
 * visit can wait for the one before it to have finished.
 */
import { StrictMode, type ComponentProps, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatLocateRowArgs } from "@/hooks/chats/use-chat-locate-row";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

type LandingState = Pick<
  ChatSessionState,
  | "snapshotLoaded"
  | "messages"
  | "events"
  | "transcriptRowContext"
  | "transcriptDerived"
  | "pendingUserMessages"
  | "queue"
  | "turnInProgress"
  | "messageDelivery"
  | "liveAssistantMessage"
  | "activeTurn"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "runStatus"
  | "transcriptWindow"
  | "transcriptBaselineEpoch"
  | "transcriptHydrationSequence"
  | "coldRewrittenMessageIds"
  | "backgroundItems"
  | "reportVisibleTranscriptRange"
  | "requestFindReadOrdinal"
  | "requestTranscriptOrdinal"
>;

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
  locateRow: vi.fn<(args: ChatLocateRowArgs) => number | null>(),
  state: { locatedOrdinal: null as number | null },
  /** The scroll requests `ChatMessages` reported settled, in order. */
  settled: [] as Array<{
    readonly requestId: number;
    readonly outcome: string;
  }>,
}));

vi.mock("@/components/chat/chat-messages", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/chat/chat-messages")>();
  const RecordingChatMessages = (
    props: ComponentProps<typeof actual.ChatMessages>,
  ): ReactNode => (
    <actual.ChatMessages
      {...props}
      onScrollRequestSettled={(requestId, outcome) => {
        mocks.settled.push({ requestId, outcome });
        props.onScrollRequestSettled?.(requestId, outcome);
      }}
    />
  );
  return { ...actual, ChatMessages: RecordingChatMessages };
});

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => mocks.handle,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
// No turn receipts here: the transcript asks for none from a host this
// suite does not stand up.
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: (args: ChatLocateRowArgs) => {
    mocks.locateRow(args);
    const ordinal = mocks.state.locatedOrdinal;
    return ordinal === null
      ? { status: "waiting" }
      : { status: "found", ordinal };
  },
}));
import {
  BotChatTranscript,
  type BotTranscriptLanding,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import {
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT_ID = "conversation-app";
const REPLY_ID = "reply-uuid";

const ASK: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Please review" }] },
  ],
};

const BOT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

function resolvedUserMessage(): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: "ask-1",
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: ASK, browserAnnotations: [] },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: "req-1",
      resolvedAt: 1_000,
      resolvedByMessageId: REPLY_ID,
    },
  };
}

/** A message between a post and its reply, so the reply is not the next row. */
function otherUserMessage(): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: "other-1",
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: ASK, browserAnnotations: [] },
    timestamp: 1_500,
    sessionAnchor: null,
  };
}

function textBlock(blockId: string, text: string): ContentBlock {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp: 2_000,
    text,
    providerNotice: null,
  };
}

function assistantMessage(input: {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly timestamp: number;
  readonly text: string;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: BOT_SENDER,
    blocks: [textBlock(`${input.messageId}:text`, input.text)],
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function reply(): Extract<Message, { role: "assistant" }> {
  return assistantMessage({
    messageId: REPLY_ID,
    turnId: null,
    timestamp: 2_000,
    text: "Here is my review",
  });
}

let requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>;
let store: UseBoundStore<StoreApi<LandingState>>;

function createLandingStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<LandingState>> {
  return create<LandingState>()(() => ({
    snapshotLoaded: true,
    messages,
    events: [],
    transcriptRowContext: {},
    transcriptDerived: null,
    pendingUserMessages: [],
    queue: { status: "idle", items: [] },
    turnInProgress: undefined,
    messageDelivery: null,
    liveAssistantMessage: null,
    activeTurn: null,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    runStatus: "idle",
    transcriptWindow: emptyTranscriptWindow(),
    transcriptBaselineEpoch: 0,
    transcriptHydrationSequence: 0,
    coldRewrittenMessageIds: new Set<string>(),
    backgroundItems: undefined,
    reportVisibleTranscriptRange: vi.fn(),
    requestFindReadOrdinal: vi.fn(),
    requestTranscriptOrdinal,
  }));
}

const THREAD_SURFACE: BotTranscriptSurface = {
  kind: "thread",
  chooseOption: vi.fn(),
  answerQuestion: null,
  discussQuestion: null,
  failedRequest: () => null,
  openTurn: null,
  sessionChatId: null,
};

/** The member directory a mounted transcript reads; none by default. */
let members: BotMemberResolver = UNRESOLVED_BOT_MEMBERS;
/** Where the mounted transcript is asked to land. */
let landing: BotTranscriptLanding | null = null;

function mountTranscript(
  messages: ReadonlyArray<Message>,
  surface: BotTranscriptSurface,
): {
  readonly rerender: () => void;
} {
  store = createLandingStore(messages);
  mocks.handle = { store } as ChatSessionStoreHandle;
  const queryClient = new QueryClient();
  const tree = (): ReactNode => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotChatTranscript
          botId={BOT_ID}
          chatId={CHAT_ID}
          hostId="host-1"
          title="Release Bot"
          instanceId="bot-thread:test"
          surface={surface}
          resolveMember={members}
          showConnecting
          header={null}
          landOn={landing}
        />
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  landing = null;
  mocks.settled.length = 0;
  members = UNRESOLVED_BOT_MEMBERS;
  requestTranscriptOrdinal = vi.fn<(ordinal: number | null) => void>();
  mocks.state.locatedOrdinal = null;
});

afterEach(() => {
  cleanup();
  mocks.handle = null;
});

function flashing(messageId: string): boolean {
  const row = document.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"]`,
  );
  if (row === null) throw new Error(`no row for ${messageId}`);
  return row.dataset.navigationHighlighted === "true";
}

describe("a transcript asked to land on a post", () => {
  it("lands on it at each visit, the same post's again once the first landing has settled and the reader has moved on", async () => {
    const view = mountTranscript(
      [resolvedUserMessage(), otherUserMessage(), reply()],
      THREAD_SURFACE,
    );
    await settleLegendList();

    landing = { messageId: "ask-1", sendPostId: null, visit: 1 };
    view.rerender();
    await settleLegendList();
    expect(flashing("ask-1")).toBe(true);
    await waitFor(() => expect(mocks.settled).toHaveLength(1));
    expect(mocks.settled[0]?.outcome).toBe("landed");

    // The reader takes over the list, which ends the flash.
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("chat-messages-scroll"));
    });
    expect(flashing("ask-1")).toBe(false);

    landing = { messageId: "ask-1", sendPostId: null, visit: 2 };
    view.rerender();
    await settleLegendList();
    expect(flashing("ask-1")).toBe(true);
    await waitFor(() => expect(mocks.settled).toHaveLength(2));
    expect(mocks.settled[1]?.outcome).toBe("landed");
  });
});
