/**
 * A member's own message in the bot's channel the moment they press Send
 * (Tracy Bots T249), through the REAL `BotChannelView`, its box and the
 * `bot.conversation.send` mutation over a fake host that HOLDS the send. The
 * row the host stores is pushed into the channel's session store, as the
 * host's stream does. Only the virtualised list is replaced (a stub that
 * draws one `ChatMessage` per row, keyed by its id), as in the failed-answer
 * suite. What the person sees is asserted: the text on a row at once, the
 * stored row taking its place, and where the text goes when the send fails.
 *
 * How a send's id is made and how a refusal is shaped lives in
 * `bot-send-identity-test-support.ts` alone.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { Fragment, StrictMode, type ReactElement, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotConversationSendRequest,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import {
  neverLeft,
  notWrittenRefusal,
  sendReceipt,
  storedRowOfSend,
  unmarkedRefusal,
} from "@/components/bots/__tests__/bot-send-identity-test-support";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  boxInput,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import type { BotReplyMode } from "@traycer/protocol/host/bot/schemas";
import {
  useBotOpenThreadStore,
  useBotRail,
} from "@/stores/bots/bot-open-thread-store";

type ChannelTranscriptState = Pick<
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
  | "holdTranscriptOrdinal"
>;

const mocks = vi.hoisted(() => ({
  channelHandle: null as ChatSessionStoreHandle | null,
  threadHandle: null as ChatSessionStoreHandle | null,
  threads: [] as BotThreadSummary[],
  client: null as HostRequester<HostRpcRegistry> | null,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    chatId === CHANNEL_ID ? mocks.channelHandle : mocks.threadHandle,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.threads, threadAnchors: null },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          {props.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              actions={null}
              backgroundToolBlockIds={noBackgroundToolBlockIds}
              nextStepActions={null}
            />
          ))}
        </div>
      </Providers>
    ),
  };
});

import { botThreadIdFor } from "@traycer/protocol/persistence/epic/messages";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { countedScriptedSession } from "@/components/bots/__tests__/bot-turn-test-support";
import {
  useBotPendingSendsStore,
  type BotPendingSend,
} from "@/stores/bots/bot-pending-sends-store";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const CHANNEL_ID = "conversation-channel";
const TEXT = "Is the nightly green?";

const resolveMember: BotMemberResolver = () => null;

/** An earlier, answered post, so the channel draws its list rather than its intro. */
const EARLIER_POST: Message = {
  role: "user",
  messageId: "post-earlier",
  sender: { type: "user", userId: "user-teammate" },
  message: {
    kind: "user",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Morning." }] },
      ],
    },
    browserAnnotations: [],
  },
  timestamp: 500,
  sessionAnchor: null,
  conversationRequest: {
    requestId: "req-earlier",
    resolvedAt: 600,
    resolvedByMessageId: null,
  },
};

/** One send the fake host holds, until the case settles it. */
interface HeldSend {
  readonly request: BotConversationSendRequest;
  readonly resolve: (threadId: string | null) => void;
  readonly reject: (error: Error) => void;
}

let sends: HeldSend[];
/** Every read-cursor write the host was asked for. */
let cursorWrites: ReadonlyArray<unknown>;
let channelStore: UseBoundStore<StoreApi<ChannelTranscriptState>>;

function createChannelStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<ChannelTranscriptState>> {
  return create<ChannelTranscriptState>()(() => ({
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
    requestTranscriptOrdinal: vi.fn(),
    holdTranscriptOrdinal: () => () => undefined,
  }));
}

/** A host client whose `bot.conversation.send` waits for the case to answer. */
function holdingHostClient(): HostRequester<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-1",
    handlers: {
      "bot.readCursor.advance": (params) => {
        cursorWrites = [...cursorWrites, params];
        return Promise.resolve({
          cursor: { messageId: params.messageId, seq: params.seq },
        });
      },
      "bot.conversation.send": (params) =>
        new Promise((resolve, reject) => {
          sends.push({
            request: params,
            resolve: (threadId) =>
              resolve(sendReceipt(params, VIEWER_USER_ID, threadId)),
            reject,
          });
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
      // The send leaves as the signed-in viewer.
      identity: {
        userId: VIEWER_USER_ID,
        username: "olive",
        providerHandle: null,
      },
    }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** The channel as the bot tab holds it: the rail's one slot is the real store. */
function RailChannel(props: { readonly replyMode: BotReplyMode }): ReactNode {
  const rail = useBotRail(BOT_ID);
  const setRail = useBotOpenThreadStore((state) => state.setRail);
  return (
    <BotChannelView
      tiles={null}
      botId={BOT_ID}
      hostId={HOST_ID}
      boundHostId={HOST_ID}
      boundHostEpoch={1}
      onBindingMoved={vi.fn()}
      botTitle="Release Bot"
      replyMode={props.replyMode}
      directive={null}
      appConversationChatId={CHANNEL_ID}
      trunkChatId="trunk-chat"
      onOpenTurn={vi.fn()}
      onOpenSession={vi.fn()}
      landOn={null}
      openMemory={null}
      onOpenMemory={vi.fn()}
      environmentId="env-1"
      botNameOf={() => null}
      environmentBots={null}
      openExchange={null}
      exchangeRail={{ open: () => undefined, close: () => undefined }}
      resolveMember={resolveMember}
      tasks={[]}
      surfaceActions={null}
      openThread={rail?.kind === "thread" ? rail : null}
      onOpenThread={(open) =>
        setRail(
          BOT_ID,
          open === null ? null : { kind: "thread", ...open },
          currentBotLifetime(),
        )
      }
      setupHistory={null}
    />
  );
}

/** The viewer signed in as `userId`: status and profile move together, as the bridge's transition reads them. */
function signInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId,
        userName: "Olive Owner",
        email: "olive@example.com",
        avatarUrl: null,
      },
      contextMetadata: { userId, username: "olive" },
    });
  });
}

function signOutViewer(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });
}

let windowView: RenderResult;
let windowQueryClient: QueryClient;
let windowReplyMode: BotReplyMode;
/**
 * Whether the window draws under StrictMode. A box seeded from a kept draft
 * applies the seed twice under it (T186, not T249), so the one case that
 * reads the seeded text back turns it off.
 */
let strictWindow: boolean;

/**
 * The window: the bridge that retires one account's drafts as another signs
 * in, the cache and the providers stay while the channel under them is shown
 * or not, as the app's channel is when the person leaves it and comes back.
 */
function windowTree(channelShown: boolean): ReactElement {
  const Mode = strictWindow ? StrictMode : Fragment;
  return (
    <Mode>
      <QueryClientProvider client={windowQueryClient}>
        <BotDraftsPersistLifecycleBridge>
          <BotTestRunnerHost>
            <TooltipProvider>
              <ChatExpansionTestProviders tileInstanceId="tile-1">
                {channelShown ? (
                  <RailChannel replyMode={windowReplyMode} />
                ) : null}
              </ChatExpansionTestProviders>
            </TooltipProvider>
          </BotTestRunnerHost>
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>
    </Mode>
  );
}

/** A whole window over `store`: what a reload gives. */
function renderChannel(
  replyMode: BotReplyMode,
  store: UseBoundStore<StoreApi<ChannelTranscriptState>>,
): void {
  channelStore = store;
  mocks.channelHandle = { store } as ChatSessionStoreHandle;
  windowReplyMode = replyMode;
  windowQueryClient = new QueryClient();
  windowView = render(windowTree(true));
}

/** The channel and its box go; the window stays. */
function unmountChannel(): void {
  windowView.rerender(windowTree(false));
}

/** The channel comes back in the same window. */
function remountChannel(): void {
  windowView.rerender(windowTree(true));
}

function mountChannel(replyMode: BotReplyMode): void {
  renderChannel(replyMode, createChannelStore([EARLIER_POST]));
}

async function findBox(): Promise<HTMLElement> {
  await screen.findByRole("group", { name: "Message Release Bot" });
  return channelBox();
}

function channelBox(): HTMLElement {
  return boxInput("Message Release Bot");
}

/** Types `text` into the channel's box and presses Enter; the host holds the send. */
function pressSend(text: string): void {
  typeInto(channelBox(), `${text}{Enter}`);
}

/** The rows of the channel carrying `text`. */
function rowsSaying(text: string): ReadonlyArray<HTMLElement> {
  return within(screen.getByTestId("chat-messages-stub"))
    .queryAllByText(text)
    .map(
      (node) =>
        node.closest<HTMLElement>('[data-testid="bot-member-row"]') ?? node,
    );
}

/** The host's stream delivers the row it stored for `request`. */
function storeRowFor(request: BotConversationSendRequest): Message {
  const row = storedRowOfSend(request, VIEWER_USER_ID, 2_000);
  act(() => {
    channelStore.setState((state) => ({
      messages: [...state.messages, row],
    }));
  });
  return row;
}

function firstSend(): HeldSend {
  const held = sends.at(0);
  if (held === undefined) throw new Error("the host was sent nothing");
  return held;
}

beforeEach(() => {
  localStorage.clear();
  strictWindow = true;
  sends = [];
  cursorWrites = [];
  mocks.client = holdingHostClient();
  negotiateBotSend(HOST_ID, { major: 1, minor: 7 });
  signInViewer(VIEWER_USER_ID);
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(async () => {
  cleanup();
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
  await resetPendingStore();
  useBotOpenThreadStore.setState({ byBotId: {} });
  resetBotFailedRequestSupport();
  mocks.channelHandle = null;
  mocks.threadHandle = null;
  mocks.threads = [];
  mocks.client = null;
});

describe("<BotChannelView /> a post the host still holds", () => {
  it("shows the person's text on a row of its own in the first render after Send", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });

    pressSend(TEXT);

    expect(rowsSaying(TEXT)).toHaveLength(1);
    expect(textOf(channelBox())).toBe("");
    await waitFor(() => expect(sends).toHaveLength(1));
  });

  it("sends the nonce the pending row is keyed by", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });

    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    expect(firstSend().request.sendNonce).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("<BotChannelView /> the host's stored row replaces the pending row", () => {
  it("leaves the text once, on the very row that was drawn, when the stored row arrives before the answer", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    const pending = rowsSaying(TEXT)[0];

    storeRowFor(firstSend().request);

    const rows = rowsSaying(TEXT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(pending);
  });

  it("keeps the stored row, and puts nothing back in the box, when the RPC then fails after the row arrived", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    storeRowFor(firstSend().request);

    await act(async () => {
      firstSend().reject(unmarkedRefusal("the host went away"));
      await Promise.resolve();
    });

    expect(rowsSaying(TEXT)).toHaveLength(1);
    expect(textOf(channelBox())).toBe("");
  });
});

describe("<BotChannelView /> a send that definitely wrote nothing", () => {
  it("takes the row away and gives the text back to the box once, when the host refused it with notWritten", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(rowsSaying(TEXT)).toHaveLength(1);

    await act(async () => {
      firstSend().reject(notWrittenRefusal("the post was refused"));
      await Promise.resolve();
    });

    expect(rowsSaying(TEXT)).toHaveLength(0);
    expect(textOf(channelBox())).toBe(TEXT);
  });

  it("takes the row away and gives the text back, when the request never left the client", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(rowsSaying(TEXT)).toHaveLength(1);

    await act(async () => {
      firstSend().reject(neverLeft("the link was down"));
      await Promise.resolve();
    });

    expect(rowsSaying(TEXT)).toHaveLength(0);
    expect(textOf(channelBox())).toBe(TEXT);
  });
});

describe("<BotChannelView /> a send whose outcome is not known", () => {
  it("keeps the row, marked not confirmed with Retry and no Edit, and leaves the box empty, when the host answered an error that does not say it wrote nothing", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    await act(async () => {
      firstSend().reject(unmarkedRefusal("resolver failed"));
      await Promise.resolve();
    });

    const rows = rowsSaying(TEXT);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/not confirmed/i)).toBeTruthy();
    expect(within(rows[0]).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(rows[0]).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(textOf(channelBox())).toBe("");
  });

  it("sends an identical second request, nonce included, when Retry is pressed", async () => {
    const user = userEvent.setup();
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () => {
      firstSend().reject(unmarkedRefusal("resolver failed"));
      await Promise.resolve();
    });

    expect(rowsSaying(TEXT)).toHaveLength(1);
    await user.click(
      within(rowsSaying(TEXT)[0]).getByRole("button", { name: "Retry" }),
    );

    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1].request).toEqual(sends[0].request);
  });

  it("stays unconfirmed with the same nonce, and restores nothing, when Retry is refused with notWritten after a first attempt that was lost", async () => {
    const user = userEvent.setup();
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });
    expect(rowsSaying(TEXT)).toHaveLength(1);
    await user.click(
      within(rowsSaying(TEXT)[0]).getByRole("button", { name: "Retry" }),
    );
    await waitFor(() => expect(sends).toHaveLength(2));

    await act(async () => {
      sends[1].reject(notWrittenRefusal("refused on the retry"));
      await Promise.resolve();
    });

    const rows = rowsSaying(TEXT);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/not confirmed/i)).toBeTruthy();
    expect(textOf(channelBox())).toBe("");
    expect(sends[1].request.sendNonce).toBe(sends[0].request.sendNonce);
  });

  it("stays unconfirmed with the same nonce, and restores nothing, when Retry never leaves the client after a first attempt that was lost", async () => {
    const user = userEvent.setup();
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });
    expect(rowsSaying(TEXT)).toHaveLength(1);
    await user.click(
      within(rowsSaying(TEXT)[0]).getByRole("button", { name: "Retry" }),
    );
    await waitFor(() => expect(sends).toHaveLength(2));

    await act(async () => {
      sends[1].reject(neverLeft("the link was down"));
      await Promise.resolve();
    });

    const rows = rowsSaying(TEXT);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/not confirmed/i)).toBeTruthy();
    expect(textOf(channelBox())).toBe("");
  });
});

/** A teammate's row, stored at `timestamp`. */
function teammateRow(
  messageId: string,
  text: string,
  timestamp: number,
): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "user-teammate" },
    timestamp,
    sessionAnchor: null,
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
    conversationRequest: {
      requestId: `req-${messageId}`,
      resolvedAt: timestamp,
      resolvedByMessageId: null,
    },
  };
}

/** The ids of the channel's rows, top to bottom. */
function rowTexts(): ReadonlyArray<string | null> {
  return within(screen.getByTestId("chat-messages-stub"))
    .getAllByTestId("bot-member-row")
    .map((row) => row.textContent);
}

describe("<BotChannelView /> where the pending row sits", () => {
  it("is the last row until it is replaced, then takes its stored place among rows that arrived meanwhile", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    act(() => {
      channelStore.setState((state) => ({
        messages: [
          ...state.messages,
          teammateRow("post-late", "Late from Tess", 3_000),
        ],
      }));
    });
    expect(rowTexts().at(-1)).toContain(TEXT);

    const stored = storedRowOfSend(firstSend().request, VIEWER_USER_ID, 2_000);
    act(() => {
      channelStore.setState((state) => ({
        messages: [state.messages[0], stored, state.messages[1]],
      }));
    });

    const rows = rowTexts();
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain(TEXT);
    expect(rows[2]).toContain("Late from Tess");
  });

  it("asks the host for no read-cursor write while it is pending", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });

    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    expect(rowsSaying(TEXT)).toHaveLength(1);
    expect(cursorWrites).toEqual([]);
  });
});

describe("<BotChannelView /> what a pending row offers", () => {
  it("has no Reply and no Create thread, and no failed-message Retry or Edit, until it is stored", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });

    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    const row = rowsSaying(TEXT)[0];
    expect(row).toBeDefined();
    expect(within(row).queryByTestId("bot-message-reply")).toBeNull();
    expect(within(row).queryByTestId("bot-message-thread")).toBeNull();
    expect(within(row).queryByTestId("bot-message-retry")).toBeNull();
    expect(within(row).queryByTestId("bot-message-edit")).toBeNull();
  });

  it("draws a multi-paragraph message exactly as the stored row draws it", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });

    typeInto(
      channelBox(),
      "First line{Shift>}{Enter}{/Shift}Second line{Enter}",
    );
    await waitFor(() => expect(sends).toHaveLength(1));
    const bodyOf = (): string | undefined =>
      within(screen.getByTestId("chat-messages-stub"))
        .getByText(/First line/)
        .closest("p")?.outerHTML;
    const pendingBody = bodyOf();
    expect(pendingBody).toContain("Second line");

    storeRowFor(firstSend().request);

    expect(bodyOf()).toBe(pendingBody);
  });
});

describe("<BotChannelView /> a pending row and the account", () => {
  it("is retired when the person signs out, and nothing is put in a box", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(rowsSaying(TEXT)).toHaveLength(1);

    signOutViewer();

    expect(rowsSaying(TEXT)).toHaveLength(0);
    expect(textOf(channelBox())).toBe("");
  });

  it("is retired when another account signs in, and a refusal that arrives later puts nothing in the new account's box", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(rowsSaying(TEXT)).toHaveLength(1);

    signInAs("user-someone-else");
    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused after the switch"));
      await Promise.resolve();
    });

    expect(rowsSaying(TEXT)).toHaveLength(0);
    expect(textOf(channelBox())).toBe("");
  });

  it("never shows a send refused after its box unmounted to the next account", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    unmountChannel();
    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused"));
      await Promise.resolve();
    });

    signInAs("user-someone-else");
    remountChannel();

    expect(rowsSaying(TEXT)).toHaveLength(0);
    expect(textOf(await findBox())).toBe("");
  });
});

describe("<BotChannelView /> a send that fails after its box unmounted, in the same window", () => {
  it("lands in the kept draft, which the remounted box holds, when the host refused it", async () => {
    strictWindow = false;
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    unmountChannel();

    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused"));
      await Promise.resolve();
    });
    remountChannel();

    expect(textOf(await findBox())).toBe(TEXT);
    expect(rowsSaying(TEXT)).toHaveLength(0);
  });

  it("offers the refused text back with Restore beside the draft kept for a newer message, when it is refused after its box unmounted", async () => {
    const user = userEvent.setup();
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    typeInto(channelBox(), "A newer draft");
    await waitFor(() =>
      expect(
        Object.keys(useBotDraftsStore.getState().threadBoxes[BOT_ID] ?? {}),
      ).toHaveLength(1),
    );
    unmountChannel();

    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused"));
      await Promise.resolve();
    });
    remountChannel();

    expect(textOf(await findBox())).toBe("A newer draft");
    expect(rowsSaying(TEXT)).toHaveLength(0);
    const failed = await screen.findByTestId(
      "bot-channel-composer-send-failed",
    );
    await user.click(within(failed).getByRole("button", { name: /restore/i }));
    expect(textOf(channelBox())).toContain(TEXT);
  });

  it("offers the refused text back with Restore, and keeps the newer draft in the box, when it is refused while the box is mounted", async () => {
    const user = userEvent.setup();
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(rowsSaying(TEXT)).toHaveLength(1);
    typeInto(channelBox(), "A newer draft");

    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused"));
      await Promise.resolve();
    });

    expect(rowsSaying(TEXT)).toHaveLength(0);
    expect(textOf(channelBox())).toBe("A newer draft");
    const failed = await screen.findByTestId(
      "bot-channel-composer-send-failed",
    );
    await user.click(within(failed).getByRole("button", { name: /restore/i }));
    expect(textOf(channelBox())).toContain(TEXT);
  });

  it("is drawn again, still one row, when the channel remounts while the host holds the send", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    unmountChannel();

    remountChannel();

    await findBox();
    expect(rowsSaying(TEXT)).toHaveLength(1);
  });
});

/** The window's pending-sends store (T249), looked up by path so this file loads before it exists. */
interface ResettableStore {
  readonly setState: (state: unknown, replace: true) => void;
  readonly getInitialState: () => unknown;
}

function isResettableStore(value: unknown): value is ResettableStore {
  return (
    typeof value === "function" &&
    "setState" in value &&
    typeof value.setState === "function" &&
    "getInitialState" in value &&
    typeof value.getInitialState === "function"
  );
}

async function resetPendingStore(): Promise<void> {
  const specifier = "@/stores/bots/bot-pending-sends-store";
  const imported: unknown = await import(/* @vite-ignore */ specifier);
  const store =
    typeof imported === "object" &&
    imported !== null &&
    "useBotPendingSendsStore" in imported
      ? imported.useBotPendingSendsStore
      : null;
  if (!isResettableStore(store)) {
    throw new Error("useBotPendingSendsStore is not exported");
  }
  act(() => {
    store.setState(store.getInitialState(), true);
  });
}

describe("<BotChannelView /> after a reload", () => {
  /** A reload: the view goes, the cache is fresh, and the pending store starts over. */
  async function reload(
    store: UseBoundStore<StoreApi<ChannelTranscriptState>>,
  ) {
    windowView.unmount();
    await resetPendingStore();
    renderChannel("direct", store);
    await findBox();
  }

  it("shows exactly one row with the text when the host's stored row is in the snapshot", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    const stored = storedRowOfSend(firstSend().request, VIEWER_USER_ID, 2_000);

    await reload(createChannelStore([EARLIER_POST, stored]));

    expect(rowsSaying(TEXT)).toHaveLength(1);
  });

  it("shows no row with the text when the host stored none", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    await reload(createChannelStore([EARLIER_POST]));

    expect(rowsSaying(TEXT)).toHaveLength(0);
  });
});

describe('<BotChannelView replyMode="thread" /> the provisional panel at Send', () => {
  it("opens the thread's panel with the person's text at Send, before the host answers", async () => {
    mountChannel("thread");
    await screen.findByRole("group", { name: "Message Release Bot" });

    pressSend(TEXT);

    const panel = await screen.findByTestId("bot-thread-panel");
    expect(within(panel).getAllByText(TEXT).length).toBeGreaterThan(0);
    expect(within(panel).queryByText(/not found/i)).toBeNull();
  });

  it("closes the panel when the receipt says the bot answered in the channel", async () => {
    mountChannel("thread");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await screen.findByTestId("bot-thread-panel");
    await waitFor(() => expect(sends).toHaveLength(1));

    await act(async () => {
      firstSend().resolve(null);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
  });

  it("moves the panel to the thread the receipt names", async () => {
    mountChannel("thread");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await screen.findByTestId("bot-thread-panel");
    await waitFor(() => expect(sends).toHaveLength(1));

    await act(async () => {
      firstSend().resolve("thread-from-receipt");
      await Promise.resolve();
    });

    const rail = useBotOpenThreadStore.getState().byBotId[BOT_ID];
    expect(rail.kind === "thread" && rail.sent?.threadId).toBe(
      "thread-from-receipt",
    );
    expect(screen.getAllByTestId("bot-thread-panel")).toHaveLength(1);
  });

  it("stays closed when the person closed it before a late receipt", async () => {
    const user = userEvent.setup();
    mountChannel("thread");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await user.click(await screen.findByTestId("bot-thread-close"));
    await waitFor(() => expect(sends).toHaveLength(1));

    await act(async () => {
      firstSend().resolve("thread-from-receipt");
      await Promise.resolve();
    });

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
  });

  it("closes the panel when the host refused the send before writing", async () => {
    mountChannel("thread");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await screen.findByTestId("bot-thread-panel");
    await waitFor(() => expect(sends).toHaveLength(1));

    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused"));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(textOf(channelBox())).toBe(TEXT);
  });

  it("keeps one panel when the same send is retried", async () => {
    const user = userEvent.setup();
    mountChannel("thread");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await screen.findByTestId("bot-thread-panel");
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });

    await user.click(
      within(rowsSaying(TEXT)[0]).getByRole("button", { name: "Retry" }),
    );
    await waitFor(() => expect(sends).toHaveLength(2));

    expect(screen.getAllByTestId("bot-thread-panel")).toHaveLength(1);
  });
});

describe('<BotChannelView replyMode="direct" /> a receipt that names a thread', () => {
  it("opens the panel on the receipt, as the posted thread does, unless nothing is open any more", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();

    await act(async () => {
      firstSend().resolve("thread-from-receipt");
      await Promise.resolve();
    });

    expect(await screen.findByTestId("bot-thread-panel")).toBeTruthy();
  });
});

const OWN_POST_ID = "post-own";
const OWN_THREAD_ID = "thread-own";
const OTHER_THREAD_ID = "thread-other";

function threadOn(threadId: string, anchorMessageId: string): BotThreadSummary {
  return {
    threadId,
    conversationId: CHANNEL_ID,
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: anchorMessageId,
      requestId: `req-${anchorMessageId}`,
      senderUserId: VIEWER_USER_ID,
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 0,
    lastReplyAt: null,
    openRequestCount: 0,
    costUsd: null,
  };
}

/** The channel holding the viewer's post and, under it, thread `OWN_THREAD_ID`, opened on the rail. */
function mountOpenThread(announcement: boolean): void {
  const anchorId = announcement ? "announcement-1" : OWN_POST_ID;
  mocks.threads = announcement
    ? []
    : [
        threadOn(OWN_THREAD_ID, OWN_POST_ID),
        threadOn(OTHER_THREAD_ID, "post-x"),
      ];
  mountChannel("thread");
  mocks.threadHandle = {
    store: createChannelStore([]),
  } as ChatSessionStoreHandle;
  act(() => {
    useBotOpenThreadStore.getState().setRail(
      BOT_ID,
      {
        kind: "thread",
        anchorMessageId: anchorId,
        announcement,
        anchorKind: null,
        sent: null,
      },
      currentBotLifetime(),
    );
  });
}

describe("<BotChannelView /> a pending reply in a thread", () => {
  it("shows the reply on a row of its own in the thread's panel at Send, and not in the channel", async () => {
    mountOpenThread(false);
    const panel = await screen.findByTestId("bot-thread-panel");
    const box = await within(panel).findByRole("group", {
      name: "Reply in the thread",
    });

    typeInto(
      box.querySelector<HTMLElement>("[data-composer-editor]") ?? box,
      `${TEXT}{Enter}`,
    );

    const inPanel = within(panel).getAllByText(TEXT);
    expect(inPanel).toHaveLength(1);
    expect(
      within(screen.getByTestId("bot-channel-messages")).queryByText(TEXT),
    ).toBeNull();
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0].request.threadId).toBe(OWN_THREAD_ID);
  });

  it("stays in its own thread when the person opens another meanwhile, and is drawn again when they come back", async () => {
    mountOpenThread(false);
    const panel = await screen.findByTestId("bot-thread-panel");
    const box = await within(panel).findByRole("group", {
      name: "Reply in the thread",
    });
    typeInto(
      box.querySelector<HTMLElement>("[data-composer-editor]") ?? box,
      `${TEXT}{Enter}`,
    );
    await waitFor(() => expect(sends).toHaveLength(1));

    act(() => {
      useBotOpenThreadStore.getState().setRail(
        BOT_ID,
        {
          kind: "thread",
          anchorMessageId: "post-x",
          announcement: false,
          anchorKind: null,
          sent: null,
        },
        currentBotLifetime(),
      );
    });
    expect(
      within(await screen.findByTestId("bot-thread-panel")).queryByText(TEXT),
    ).toBeNull();

    act(() => {
      useBotOpenThreadStore.getState().setRail(
        BOT_ID,
        {
          kind: "thread",
          anchorMessageId: OWN_POST_ID,
          announcement: false,
          anchorKind: null,
          sent: null,
        },
        currentBotLifetime(),
      );
    });
    expect(
      within(await screen.findByTestId("bot-thread-panel")).getAllByText(TEXT),
    ).toHaveLength(1);
  });
});

describe("<BotChannelView /> the first reply under an announcement", () => {
  it("opens the thread at Send under the id the protocol derives, with the reply on a row of its own", async () => {
    mountOpenThread(true);
    const panel = await screen.findByTestId("bot-thread-panel");
    const box = await within(panel).findByRole("group", {
      name: "Reply in a new thread",
    });

    typeInto(
      box.querySelector<HTMLElement>("[data-composer-editor]") ?? box,
      `${TEXT}{Enter}`,
    );

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(within(panel).getAllByText(TEXT)).toHaveLength(1);
    const rail = useBotOpenThreadStore.getState().byBotId[BOT_ID];
    expect(rail.kind === "thread" && rail.sent?.threadId).toBe(
      botThreadIdFor(BOT_ID, "announcement-1"),
    );
    expect(within(panel).queryByText(/not found/i)).toBeNull();
  });
});

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Pastes an image copied from another box (its composer document) into the channel's box. */
function pasteImage(fileName: string): void {
  const value = JSON.stringify({
    schema: "traycer.composer-content",
    version: 1,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "copy",
                fileName,
                mimeType: "image/png",
                b64content: PNG_BASE64,
              },
            },
          ],
        },
      ],
    },
  });
  fireEvent.paste(channelBox(), {
    clipboardData: {
      types: ["application/x-traycer-composer+json"],
      files: [],
      items: [],
      getData: (type: string) =>
        type === "application/x-traycer-composer+json" ? value : "",
    },
  });
}

describe("<BotChannelView /> a pending row that carries an image", () => {
  it("shows the text and the image on one row at Send, and still one image on one row once the stored row arrives", async () => {
    mountChannel("direct");
    await screen.findByRole("group", { name: "Message Release Bot" });
    pasteImage("release-train.png");
    await screen.findByTestId("bot-channel-composer-images");
    typeInto(channelBox(), `${TEXT}{Enter}`);
    await waitFor(() => expect(sends).toHaveLength(1));

    const pending = rowsSaying(TEXT);
    expect(pending).toHaveLength(1);
    expect(
      within(pending[0]).getAllByRole("img", { name: "release-train.png" }),
    ).toHaveLength(1);

    storeRowFor(firstSend().request);

    const stored = rowsSaying(TEXT);
    expect(stored).toHaveLength(1);
    expect(
      within(stored[0]).getAllByRole("img", { name: "release-train.png" }),
    ).toHaveLength(1);
  });
});

/** The host's answer to a subscribe on a channel it has not created yet. */
const NOT_VISIBLE: FatalErrorDetails = {
  code: "CHAT_NOT_VISIBLE",
  reason: "CHAT_NOT_VISIBLE: not visible",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/** The window over a real session `handle`, as a reload gives. */
function renderChannelOver(handle: ChatSessionStoreHandle): void {
  mocks.channelHandle = handle;
  windowReplyMode = "direct";
  windowQueryClient = new QueryClient();
  windowView = render(windowTree(true));
}

/**
 * A channel the host has not created yet: the real session store, closed by
 * its answer `CHAT_NOT_VISIBLE`, which the channel draws as its opening. The
 * session counts the streams it opens again.
 */
async function mountChannelNotCreatedYet() {
  const session = countedScriptedSession(CHANNEL_ID, []);
  session.store.setState({
    snapshotLoaded: false,
    connectionStatus: "closed",
    fatalClose: NOT_VISIBLE,
  });
  renderChannelOver(session.handle);
  await findBox();
  return session;
}

/** What the page holds, for a failure message that says what was drawn instead. */
function pageText(): string {
  return document.body.textContent.slice(0, 400);
}

function onlyHeldSend(): BotPendingSend[] {
  return Object.values(useBotPendingSendsStore.getState().entries).filter(
    (entry): entry is BotPendingSend => entry !== undefined,
  );
}

describe("<BotChannelView /> a first post into a channel the host has not created yet", () => {
  it("CONTROL: draws the opening alone, and opens no stream again, when nothing was sent", async () => {
    const session = await mountChannelNotCreatedYet();

    expect(screen.getByTestId("bot-channel-not-here-yet")).toBeTruthy();
    expect(screen.queryAllByTestId("bot-member-row")).toHaveLength(0);
    expect(session.resubscribes()).toBe(0);
  });

  it("draws a held first post beside the opening, with its text", async () => {
    await mountChannelNotCreatedYet();

    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    expect(onlyHeldSend(), "the send was not held").toHaveLength(1);
    expect(
      screen.queryByTestId("bot-channel-not-here-yet"),
      "the opening went",
    ).not.toBeNull();
    expect(
      screen.queryAllByText(TEXT),
      `the held first post was not drawn: ${pageText()}`,
    ).not.toHaveLength(0);
  });

  it("draws an uncertain first post unconfirmed, with Retry reachable", async () => {
    await mountChannelNotCreatedYet();
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));

    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });

    expect(
      onlyHeldSend().map((send) => send.state),
      "the send did not end unconfirmed",
    ).toEqual(["uncertain"]);
    expect(
      screen.queryAllByText(/not confirmed/i),
      `the uncertain first post was not drawn unconfirmed: ${pageText()}`,
    ).not.toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Retry" }),
      `Retry is not reachable: ${pageText()}`,
    ).not.toBeNull();
  });

  it("subscribes the session again once for an uncertain first post, and never again for repeated closes or a remount", async () => {
    const session = await mountChannelNotCreatedYet();
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });
    expect(
      onlyHeldSend().map((send) => send.state),
      "the send did not end unconfirmed",
    ).toEqual(["uncertain"]);

    expect(
      session.resubscribes(),
      "an uncertain first post did not subscribe the session again",
    ).toBe(1);
    // The host answers every subscribe that the channel is still not there.
    act(() => {
      session.store.setState({
        connectionStatus: "closed",
        fatalClose: NOT_VISIBLE,
      });
    });
    act(() => {
      session.store.setState({
        connectionStatus: "closed",
        fatalClose: { ...NOT_VISIBLE },
      });
    });
    unmountChannel();
    remountChannel();
    act(() => {
      session.store.setState({
        connectionStatus: "closed",
        fatalClose: { ...NOT_VISIBLE },
      });
    });

    expect(
      session.resubscribes(),
      "repeated closes or a remount subscribed the session again",
    ).toBe(1);
  });

  it("hands an accepted first post off to the host's stored row under the same id: one row, the stored one", async () => {
    const session = await mountChannelNotCreatedYet();
    pressSend(TEXT);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(
      screen.queryAllByText(TEXT),
      `the held first post was not drawn: ${pageText()}`,
    ).not.toHaveLength(0);

    await act(async () => {
      firstSend().resolve(null);
      await Promise.resolve();
    });
    // The host created the channel with the post: its stream now carries the stored row.
    const stored = storedRowOfSend(firstSend().request, VIEWER_USER_ID, 2_000);
    act(() => {
      session.store.setState({
        fatalClose: null,
        snapshotLoaded: true,
        connectionStatus: "open",
        messages: [stored],
      });
    });

    expect(
      rowsSaying(TEXT),
      `the stored row and the pending row were not one row: ${pageText()}`,
    ).toHaveLength(1);
    expect(onlyHeldSend(), "the pending send was still held").toHaveLength(0);
    expect(screen.queryByText(/not confirmed/i)).toBeNull();
  });
});
