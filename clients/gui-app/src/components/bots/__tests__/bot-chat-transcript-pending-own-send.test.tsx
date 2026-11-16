/**
 * A member's own send, drawn while its host has not answered, through the
 * bot's channel on the windowed line (Tracy Bots T249): the REAL chat session
 * store fed a host's frames, the real `BotChatTranscript` with the real
 * windowed `ChatMessages` list, the real pending store and `usePendingSendRows`.
 *
 * The send is drawn the moment it is pressed, under the id the host will
 * store it as. The host's index then names that row at the next ordinal
 * (`indexChanged`) before any frame has carried its body, and the body arrives
 * after: in R1 as the range response the list asks the host for, in R1b as the
 * host's shared `messageAccepted` frame (a LIVE RECORD the window holds until
 * a range response carries it). At each of the three
 * steps the person must see one row, the same row, with its text.
 */
import { botMentionHostClientMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  answerRangeWith,
  createWindowedSession,
  indexNamesAppendedRow,
  indexReindexed,
  messageAccepted,
  openWindowedChat,
  recoverWindowedChat,
  paragraph,
  userSkeletonEntry,
  type WindowedChatIds,
  type WindowedSession,
} from "@/components/bots/__tests__/bot-windowed-session-test-support";
import { storedRowOfSend } from "@/components/bots/__tests__/bot-send-identity-test-support";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { BOT_CONVERSATION_NONCE_VERSION } from "@/hooks/bots/use-bot-send-version";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { ChatMessages } from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import {
  BotChatTranscript,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import {
  startPendingSend,
  type BotPendingSendStart,
} from "@/lib/bots/bot-pending-send";
import {
  settlePendingSend,
  useBotPendingSendsStore,
} from "@/stores/bots/bot-pending-sends-store";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
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
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));

const IDS: WindowedChatIds = {
  epicId: BOT_ID,
  chatId: CHANNEL_ID,
  hostId: HOST_ID,
  ownerId: VIEWER_USER_ID,
  title: "Channel",
};

const TEXT = "Is the nightly green?";
/** When the host stored the post: far from the press, so the stamp tells which drew. */
const HOST_STORED_AT = Date.UTC(2020, 0, 2, 3, 4, 5);

const EARLIER: Extract<OpenMessage, { role: "user" }> = {
  role: "user",
  messageId: "earlier-post",
  sender: { type: "user", userId: "user-teammate" },
  message: {
    kind: "user",
    content: paragraph("Morning."),
    browserAnnotations: [],
  },
  timestamp: 500,
  sessionAnchor: null,
};

const BINDING = {
  hostId: HOST_ID,
  boundHostId: HOST_ID,
  boundHostEpoch: 1,
  onMoved: () => undefined,
};

function channelSurface(): BotTranscriptSurface {
  return {
    kind: "channel",
    threadLine: () => null,
    openThread: null,
    openAnnouncementThread: null,
    threadAnchorKinds: [],
    chooseOption: null,
    reply: null,
    answerQuestion: null,
    answerQuestions: null,
    questionBox: null,
    failedRequest: () => null,
    openTurn: null,
    sessionChatId: null,
    intro: { botTitle: "Release Bot", directive: null },
    history: null,
  };
}

let session: WindowedSession;

/** The channel mounted over `session`, with the bot's binding the send was made for. */
function mountChannel(sendBinding: typeof BINDING | null): void {
  mocks.handle = session.handle;
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotIdentityContext
            value={{ botId: BOT_ID, title: "Release Bot", owner: null }}
          >
            <BotChatTranscript
              botId={BOT_ID}
              chatId={CHANNEL_ID}
              hostId={HOST_ID}
              title="Release Bot"
              instanceId="bot-channel:windowed"
              surface={channelSurface()}
              resolveMember={UNRESOLVED_BOT_MEMBERS}
              showConnecting
              header={null}
              landOn={null}
              flow={null}
              sendBinding={sendBinding}
            />
          </BotIdentityContext>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

/** The member presses Send: the real start of a send, drawn at once. */
function pressSend(): {
  readonly rowId: string;
  readonly request: BotConversationSendRequest;
} {
  const held: { started: BotPendingSendStart | null } = { started: null };
  act(() => {
    held.started = startPendingSend({
      request: {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: TEXT,
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
      },
      authority: { hostId: HOST_ID, hostEpoch: 1 },
      senderUserId: VIEWER_USER_ID,
      sentAs: { lifetime: currentBotLifetime(), account: VIEWER_USER_ID },
      text: TEXT,
      content: paragraph(TEXT),
      images: [],
      release: () => undefined,
    });
  });
  if (held.started === null) throw new Error("Send started nothing");
  const { messageId, request } = held.started;
  return { rowId: messageId, request };
}

/** What the page shows of the rows carrying `text`: each row, whole. */
function rowsSaying(text: string): HTMLElement[] {
  return screen
    .queryAllByTestId("bot-member-row")
    .filter((row) => row.textContent.includes(text));
}

/** The single row of the send, or a failure that says what was drawn instead. */
function theRow(step: string): HTMLElement {
  const rows = rowsSaying(TEXT);
  expect(
    rows,
    `${step}: the send was drawn as ${String(rows.length)} row(s); the page shows: ${document.body.textContent.slice(0, 300)}`,
  ).toHaveLength(1);
  return rows[0];
}

beforeEach(() => {
  installLegendListTestClock();
  installLegendListViewportMetrics();
  signInViewer(VIEWER_USER_ID);
  // A held send exists only where the host took its nonce.
  negotiateBotSend(HOST_ID, BOT_CONVERSATION_NONCE_VERSION);
  session = createWindowedSession(IDS);
  openWindowedChat(session, IDS, {
    messages: [EARLIER],
    events: [],
    activeTurnId: null,
    chatId: CHANNEL_ID,
  });
});

afterEach(() => {
  cleanup();
  session.handle.dispose();
  mocks.handle = null;
  useBotPendingSendsStore.setState(
    useBotPendingSendsStore.getInitialState(),
    true,
  );
  resetBotFailedRequestSupport();
});

describe("a member's own send in the channel's windowed list, drawn before its host answers", () => {
  it("stays one row, the same row, with its text, from the press through the index naming it to its body arriving by the range the list asks for", async () => {
    mountChannel(BINDING);
    await settleLegendList();
    const { rowId, request } = pressSend();
    await settleLegendList();
    const drawn = theRow("at the press");
    const rangesBefore = session.rangeRequests.length;

    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(rowId, Date.now()),
      });
    });
    await settleLegendList();

    expect(
      theRow("after the index named the row, before its body"),
      "the row was replaced by another node",
    ).toBe(drawn);
    // The body is not held: the list must keep asking the host for the row.
    expect(
      session.rangeRequests
        .slice(rangesBefore)
        .some((range) => range.fromOrdinal <= 1 && range.toOrdinal >= 1),
      "the list asked the host for no range covering the named row",
    ).toBe(true);

    act(() => {
      answerRangeWith(session, IDS, {
        messages: [
          EARLIER,
          storedRowOfSend(request, VIEWER_USER_ID, HOST_STORED_AT),
        ],
        events: [],
        activeTurnId: null,
        chatId: CHANNEL_ID,
      });
    });
    await settleLegendList();

    const stored = theRow("after the range carried the body");
    expect(stored, "the stored row replaced the drawn node").toBe(drawn);
    expect(
      within(stored).getByRole("time").getAttribute("datetime"),
      "the row does not show the host's timestamp",
    ).toBe(new Date(HOST_STORED_AT).toISOString());
    const order = screen
      .getAllByTestId("bot-member-row")
      .map((row) => row.textContent);
    expect(order).toHaveLength(2);
    expect(order[0]).toContain("Morning.");
    expect(order[1]).toContain(TEXT);
  });

  it("CONTROL: offers no Retry to an unconfirmed send when the channel has no binding to send under", async () => {
    mountChannel(null);
    await settleLegendList();
    const { rowId } = pressSend();
    act(() => {
      settlePendingSend(rowId, "uncertain");
    });
    await settleLegendList();

    const row = theRow("unconfirmed, no binding");
    expect(row.textContent).toMatch(/Not confirmed/);
    const retry = within(row).getByTestId("bot-message-unconfirmed-retry");
    if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry");
    expect(retry.disabled, "Retry was offered with no binding").toBe(true);
  });

  it("keeps an unconfirmed send's Retry drawn, enabled and the same, at every step, and one row after its body arrives as a live record", async () => {
    mountChannel(BINDING);
    await settleLegendList();
    const { rowId, request } = pressSend();
    act(() => {
      settlePendingSend(rowId, "uncertain");
    });
    await settleLegendList();
    const retryOf = (step: string): HTMLButtonElement => {
      const row = theRow(step);
      const retry = within(row).getByTestId("bot-message-unconfirmed-retry");
      if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry");
      return retry;
    };
    const drawn = theRow("unconfirmed at the press");
    expect(drawn.textContent).toMatch(/Not confirmed/);
    expect(retryOf("unconfirmed at the press").disabled).toBe(false);

    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(rowId, Date.now()),
      });
    });
    await settleLegendList();

    expect(theRow("unconfirmed, index named the row")).toBe(drawn);
    expect(drawn.textContent).toMatch(/Not confirmed/);
    expect(
      retryOf("unconfirmed, index named the row").disabled,
      "Retry changed state when the index named the row",
    ).toBe(false);

    act(() => {
      messageAccepted(
        session,
        IDS,
        storedRowOfSend(request, VIEWER_USER_ID, HOST_STORED_AT),
      );
    });
    await settleLegendList();

    expect(rowsSaying(TEXT)).toHaveLength(1);
    expect(screen.queryAllByText(/Not confirmed/)).toHaveLength(0);
  });
});

/*
 * A held send while the window is void (a reindex): the list draws only the
 * ordinal space then, and what the chat holds that the host has not indexed
 * yet must stay as it was, text and Retry included, for as long as the
 * replacement snapshot is not answered. Recovery then brings the host's own
 * row, under the same id, and the send is that one row.
 */
describe("a member's own send held while the transcript window is void", () => {
  /** The host reindexes under the held send: the window goes void, and nothing replaces it yet. */
  function voidTheWindow(rowCount: number): void {
    act(() => {
      indexReindexed(session, IDS, { epoch: 2, rowCount, indexRevision: 3 });
    });
    expect(
      session.handle.store.getState().transcriptWindow.invalidated,
      "the reindex did not void the window",
    ).toBe(true);
  }

  /** The host answers the replacement: a fresh snapshot that holds the stored send. */
  function recover(request: BotConversationSendRequest): void {
    act(() => {
      recoverWindowedChat(
        session,
        IDS,
        {
          messages: [
            EARLIER,
            storedRowOfSend(request, VIEWER_USER_ID, HOST_STORED_AT),
          ],
          events: [],
          activeTurnId: null,
          chatId: CHANNEL_ID,
        },
        { epoch: 2, indexRevision: 4 },
      );
    });
    expect(
      session.handle.store.getState().transcriptWindow.invalidated,
      "the fresh snapshot did not recover the window",
    ).toBe(false);
  }

  /** The one row of the send is the host's: it shows the host's timestamp. */
  function expectHostsRow(step: string): void {
    expect(
      within(theRow(step)).getByRole("time").getAttribute("datetime"),
      `${step}: the row is not the host's`,
    ).toBe(new Date(HOST_STORED_AT).toISOString());
  }

  /** The index names the send's row at the next ordinal, before any body. */
  function named(rowId: string): void {
    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(rowId, Date.now()),
      });
    });
  }

  it("V1: stays one row, the same row, with its text, while the replacement is held, and is the host's one row after it is answered", async () => {
    mountChannel(BINDING);
    await settleLegendList();
    const { rowId, request } = pressSend();
    await settleLegendList();
    named(rowId);
    await settleLegendList();
    const drawn = theRow("after the index named the row");

    voidTheWindow(2);
    await settleLegendList();

    expect(
      theRow("while the window was void"),
      "the row was replaced by another node",
    ).toBe(drawn);

    recover(request);
    await settleLegendList();

    expect(
      rowsSaying(TEXT),
      "after the window recovered the send was not one row",
    ).toHaveLength(1);
    expectHostsRow("after the window recovered");
  });

  it("V2: keeps an unconfirmed send's Retry drawn and enabled while the replacement is held, and one host row after it is answered", async () => {
    mountChannel(BINDING);
    await settleLegendList();
    const { rowId, request } = pressSend();
    act(() => {
      settlePendingSend(rowId, "uncertain");
    });
    await settleLegendList();
    named(rowId);
    await settleLegendList();
    const drawn = theRow("unconfirmed, after the index named the row");

    voidTheWindow(2);
    await settleLegendList();

    const voidRow = theRow("unconfirmed, while the window was void");
    expect(voidRow).toBe(drawn);
    const retry = within(voidRow).getByTestId("bot-message-unconfirmed-retry");
    if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry");
    expect(retry.disabled, "Retry was withheld in the void").toBe(false);

    recover(request);
    await settleLegendList();

    expect(rowsSaying(TEXT)).toHaveLength(1);
    expectHostsRow("unconfirmed, after the window recovered");
    expect(screen.queryAllByText(/Not confirmed/)).toHaveLength(0);
  });

  it("V4: a void before any index entry names the row keeps the send as one row with its text, and one host row after recovery", async () => {
    mountChannel(BINDING);
    await settleLegendList();
    const { request } = pressSend();
    await settleLegendList();
    const drawn = theRow("at the press");

    voidTheWindow(1);
    await settleLegendList();

    expect(
      theRow("while the window was void, no index entry naming the row"),
      "the row was replaced by another node",
    ).toBe(drawn);

    recover(request);
    await settleLegendList();

    expect(
      rowsSaying(TEXT),
      "after the window recovered the send was not one row",
    ).toHaveLength(1);
    expectHostsRow("after the window recovered");
  });
});

/*
 * The same three steps for an ordinary chat's optimistic message (no bot),
 * from the chat session store's own send action: the real `sendMessage` makes
 * the pending user message and the real renderer draws it as the chat tile
 * does, in the real windowed `ChatMessages`. This is what the list draws
 * TODAY at each step, and must still draw after a bot's own-send rule is
 * added.
 */

const ORDINARY_DISPLAY: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveUserSenderAvatarUrl: () => null,
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  resolveAgentServiceTierLabel: () => null,
  contentBlocksPreview: () => "",
};

const noop = (): void => undefined;

/** The chat tile's list: the session's rendered rows, with its pending user messages. */
function OrdinaryChatList(): ReactNode {
  const state = session.handle.store();
  const subagentDrillIn = useSubagentDrillIn(state.snapshotLoaded);
  const messages = useRenderedMessages(
    {
      messages: state.messages,
      events: state.events,
      rowContext: state.transcriptRowContext,
      setupCardWindows: [],
      pendingUserMessages: state.pendingUserMessages,
      withdrawnMessageId: null,
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      epicId: BOT_ID,
      ownerId: CHANNEL_ID,
      ownerKind: "chat",
      viewTabId: "tab-ordinary",
    },
    ORDINARY_DISPLAY,
  );
  return (
    <ChatMessages
      minimapEnabled={false}
      taskTitle="Chat"
      taskId={CHANNEL_ID}
      epicId={BOT_ID}
      hostId={HOST_ID}
      messages={messages}
      transcriptWindow={state.transcriptWindow}
      onVisibleOrdinalRangeChange={state.reportVisibleTranscriptRange}
      onFindReadOrdinalChange={state.requestFindReadOrdinal}
      baselineEpoch={state.transcriptBaselineEpoch}
      hydrationSequence={state.transcriptHydrationSequence}
      coldRewrittenMessageIds={state.coldRewrittenMessageIds}
      backgroundItems={state.backgroundItems}
      getMessageActions={() => null}
      nextStepActions={null}
      instanceId="tab-ordinary"
      visible
      systemOverlayActive={false}
      scrollRequest={null}
      onScrollRequestSettled={noop}
      composerOverlayHeight={0}
      subagentDrillIn={subagentDrillIn}
    />
  );
}

const ORDINARY_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

describe("an ordinary chat's optimistic message in the same windowed list (no bot)", () => {
  it("is drawn once, with its text, at the press, when the index names it before its body, and when its body arrives", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <OrdinaryChatList />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await settleLegendList();
    const out: { sent: { readonly messageId: string } | null } = { sent: null };
    act(() => {
      out.sent = session.handle.store.getState().sendMessage({
        content: paragraph(TEXT),
        sender: { type: "user", userId: VIEWER_USER_ID },
        settings: ORDINARY_SETTINGS,
        attachments: [],
        deliveryPolicy: "auto",
        restore: { content: paragraph(TEXT), browserAnnotations: [] },
      });
    });
    if (out.sent === null) throw new Error("the chat refused the send");
    const { messageId } = out.sent;
    await settleLegendList();
    const textRows = (): HTMLElement[] =>
      screen.queryAllByText(TEXT).map((node) => node);
    expect(
      textRows(),
      `at the press: ${document.body.textContent.slice(0, 300)}`,
    ).toHaveLength(1);

    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(messageId, Date.now()),
      });
    });
    await settleLegendList();
    expect(
      textRows(),
      `the index named the optimistic row before its body: ${document.body.textContent.slice(0, 300)}`,
    ).toHaveLength(1);

    act(() => {
      messageAccepted(session, IDS, {
        ...EARLIER,
        messageId,
        message: { ...EARLIER.message, content: paragraph(TEXT) },
        timestamp: HOST_STORED_AT,
      });
    });
    await settleLegendList();
    expect(
      textRows(),
      `the body arrived: ${document.body.textContent.slice(0, 300)}`,
    ).toHaveLength(1);
  });
});
