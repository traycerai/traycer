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
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import type { StoreApi, UseBoundStore } from "zustand";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatLocateRowArgs } from "@/hooks/chats/use-chat-locate-row";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  BOT_ID,
  CHAT_ID,
  createLandingStore,
  otherUserMessage,
  reply,
  resolvedUserMessage,
  type LandingState,
} from "@/components/bots/__tests__/bot-chat-transcript-landing-support";

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

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
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
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { useBotSearchStore } from "@/stores/bots/bot-search-store";

let requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>;
let store: UseBoundStore<StoreApi<LandingState>>;

const THREAD_SURFACE: BotTranscriptSurface = {
  kind: "thread",
  chooseOption: vi.fn(),
  reply: null,
  answerQuestion: null,
  answerQuestions: null,
  questionBox: "post-1",
  failedRequest: () => null,
  openTurn: null,
  sessionChatId: null,
  opening: { messageId: "post-1", conversationId: "channel-1", show: vi.fn() },
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
  store = createLandingStore(messages, requestTranscriptOrdinal);
  mocks.handle = { store } as ChatSessionStoreHandle;
  const queryClient = new QueryClient();
  const tree = (): ReactNode => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTestRunnerHost>
          <BotChatTranscript
            botId={BOT_ID}
            chatId={CHAT_ID}
            hostId="host-1"
            boundHostId={null}
            title="Release Bot"
            instanceId="bot-thread:test"
            surface={surface}
            resolveMember={members}
            showConnecting
            header={null}
            landOn={landing}
            flow={null}
          />
        </BotTestRunnerHost>
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

beforeEach(() => {
  installLegendListTestClock();
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
  vi.unstubAllGlobals();
  useBotSearchStore.getState().clearMarks();
});

function flashing(messageId: string): boolean {
  const row = document.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"]`,
  );
  if (row === null) throw new Error(`no row for ${messageId}`);
  return row.dataset.navigationHighlighted === "true";
}

describe("a loaded thread transcript", () => {
  it("keeps its replies and landing without a minimap", async () => {
    landing = { messageId: "ask-1", sendPostId: null, visit: 1 };
    mountTranscript(
      [resolvedUserMessage(), otherUserMessage(), reply()],
      THREAD_SURFACE,
    );
    await settleLegendList();
    await waitFor(() => expect(flashing("ask-1")).toBe(true));
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
  });

  it("lands on the post a reply's badge names when the badge is chosen", async () => {
    members = (userId) =>
      userId === "owner-1"
        ? { displayName: "Olive Owner", avatarUrl: null }
        : null;
    mountTranscript(
      [
        resolvedUserMessage(),
        otherUserMessage(),
        { ...reply(), repliesTo: "ask-1" },
      ],
      THREAD_SURFACE,
    );
    await settleLegendList();
    expect(flashing("ask-1")).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Replying to Olive Owner: Please review",
      }),
    );
    await settleLegendList();

    expect(flashing("ask-1")).toBe(true);
    await waitFor(() => expect(mocks.settled).toHaveLength(1));
    expect(mocks.settled[0]?.outcome).toBe("landed");
  });
});

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

  it("marks the words a search result matched on the row it lands on, in the find colours", async () => {
    const painted = new Map<string, { readonly ranges: readonly Range[] }>();
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: { readonly ranges: readonly Range[] }) =>
          painted.set(name, highlight),
        delete: (name: string) => painted.delete(name),
      },
    });
    vi.stubGlobal(
      "Highlight",
      class PaintedHighlight {
        readonly ranges: readonly Range[];
        constructor(...ranges: readonly Range[]) {
          this.ranges = ranges;
        }
      },
    );
    useBotSearchStore.setState({
      marks: { chatId: CHAT_ID, messageId: "ask-1", words: ["review"] },
    });
    const view = mountTranscript(
      [resolvedUserMessage(), otherUserMessage(), reply()],
      THREAD_SURFACE,
    );
    await settleLegendList();
    landing = { messageId: "ask-1", sendPostId: null, visit: 1 };
    view.rerender();
    await settleLegendList();

    const markedRows = [...painted.values()].flatMap((highlight) =>
      highlight.ranges.map(
        (range) =>
          range.startContainer.parentElement?.closest<HTMLElement>(
            "[data-message-id]",
          )?.dataset.messageId,
      ),
    );
    const markedWords = [...painted.values()].flatMap((highlight) =>
      highlight.ranges.map((range) => range.toString()),
    );
    expect(markedWords).toEqual(["review"]);
    expect(markedRows).toEqual(["ask-1"]);
    expect(flashing("ask-1")).toBe(true);

    cleanup();
    expect(painted.size).toBe(0);
  });
});
