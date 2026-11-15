import { useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { ChatMessages } from "@/components/chat/chat-messages";
import {
  ChatBotPendingRowIdsContext,
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  answerRangeWith,
  createWindowedSession,
  indexNamesAppendedRow,
  openWindowedChat,
  paragraph,
  userSkeletonEntry,
  type WindowedChatIds,
  type WindowedTranscript,
} from "@/components/bots/__tests__/bot-windowed-session-test-support";
import { storedRowOfSend } from "@/components/bots/__tests__/bot-send-identity-test-support";
import { useBotSessionMessages } from "@/hooks/bots/use-bot-session-messages";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { startPendingSend } from "@/lib/bots/bot-pending-send";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useHeldPendingSends } from "@/stores/bots/bot-pending-sends-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A BOT'S CHANNEL WITH THE MEMBER'S OWN PENDING ROW (Tracy Bots T249), ON THE
 * WINDOWED LINE.
 *
 * The real chat session store, fed the frames a host sends it (the shared
 * builders of `windowed-session-frames.ts`: a snapshot, the row skeleton, an
 * index delta, a range response), under the real `useBotSessionMessages`,
 * which appends the sends the real pending store holds and names the rows it
 * drew, and the real `ChatMessages` list, given those ids the way the
 * channel's transcript gives them. Nothing of the list's follow or anchor
 * behaviour is reimplemented here.
 *
 * `window.__pendingDriver` plays the three steps of a send: `press` (the
 * held row is drawn), `indexNamesPending` (the host's index names the row at
 * its ordinal, no body yet), `answerRange` (the range response the list asked
 * for carries the stored rows). `indexNamesTeammate` has a teammate's post
 * named after the send, for the anchor case.
 */
const HOST_ID = "pending-follow-host";
const BOT_ID = "bot-pending";
const CHANNEL_ID = "channel-pending";
const VIEWER_ID = "user-viewer";
const PENDING_TEXT = "PENDING-OWN-ROW the nightly is green?";
const TEAMMATE_ID = "post-late";

const IDS: WindowedChatIds = {
  epicId: BOT_ID,
  chatId: CHANNEL_ID,
  hostId: HOST_ID,
  ownerId: VIEWER_ID,
  title: "Channel",
};

const PRESENTATION: ChatBotPresentation = {
  botTitle: "Release Bot",
  threadLine: null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  reply: null,
  questions: null,
  failedRequest: null,
  failedRecovery: null,
  replyReceipt: null,
  requestReceipt: null,
};

function teammatePost(
  id: string,
  text: string,
  minute: number,
): Extract<OpenMessage, { role: "user" }> {
  return {
    role: "user",
    messageId: id,
    sender: { type: "user", userId: "user-teammate" },
    message: { kind: "user", content: paragraph(text), browserAnnotations: [] },
    timestamp: Date.UTC(2020, 0, 1, 9, minute),
    sessionAnchor: null,
  };
}

const EARLIER: ReadonlyArray<OpenMessage> = Array.from(
  { length: 40 },
  (_unused, index) =>
    teammatePost(
      `post-${String(index)}`,
      `Earlier post ${String(index)}: a line long enough to take real height in the channel column.`,
      index,
    ),
);

/** What the page reads of the list and of the host's side of the exchange. */
interface PendingProbe {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distance: number;
  /** Rows carrying the pending text, wherever they are in the list. */
  readonly rowsWithPendingText: number;
  readonly pendingTop: number | null;
  readonly pendingHeight: number | null;
  readonly pendingInView: boolean;
  /** How many of the send's row and the teammate's post the window holds the body of. */
  readonly bodiesHeld: number;
  /** The rows the list was last handed, held sends included. */
  readonly rowsHanded: number;
  /** Rows carrying the teammate's post. */
  readonly teammateRows: number;
  /** The newest row drawn is the pending one. */
  readonly pendingIsLastRow: boolean;
  /** The ranges the list has asked the host for. */
  readonly rangeRequests: number;
  readonly anchorId: string | null;
  readonly anchorTop: number | null;
}

interface PendingDriver {
  ready: boolean;
  /** The person pressed Send: the held row is drawn after the session's. */
  press: () => void;
  /** The host's index names the send's row at the next ordinal: no body yet. */
  indexNamesPending: () => void;
  /** The host's index names a teammate's post after the send. */
  indexNamesTeammate: () => void;
  /**
   * Answers the list's newest unanswered range request from the host's
   * transcript, which holds the send and any teammate post named so far;
   * false when the list has asked for none.
   */
  answerRange: () => boolean;
  probe: () => PendingProbe;
}

interface DriverWindow extends Window {
  __pendingDriver?: PendingDriver;
}
const driverWindow: DriverWindow = window;

const session = createWindowedSession(IDS);
let hostMessages: ReadonlyArray<OpenMessage> = EARLIER;
let sentRequest: BotConversationSendRequest | null = null;
let rowCount = EARLIER.length;
let indexRevision = 1;
let rangesAnswered = 0;
let rowsHanded = 0;

function hostTranscript(): WindowedTranscript {
  return {
    messages: hostMessages,
    events: [],
    activeTurnId: null,
    chatId: CHANNEL_ID,
  };
}
openWindowedChat(session, IDS, hostTranscript());

function scrollNode(): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]',
  );
  if (node === null) throw new Error("the list has no scroll node");
  return node;
}

function memberRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="bot-member-row"]'),
  );
}

/**
 * The topmost row whose top is at or below the scroll node's top: what the
 * reader is looking at. The list recycles row nodes, so the DOM order is not
 * the order on the page.
 */
function anchorRow(): HTMLElement | null {
  const top = scrollNode().getBoundingClientRect().top;
  let anchor: HTMLElement | null = null;
  for (const row of memberRows()) {
    const rowTop = row.getBoundingClientRect().top;
    if (
      rowTop >= top &&
      (anchor === null || rowTop < anchor.getBoundingClientRect().top)
    ) {
      anchor = row;
    }
  }
  return anchor;
}

/** The ids of the rows the host appended, whose bodies the window holds in a span. */
function bodiesHeld(): number {
  const { spans } = session.handle.store.getState().transcriptWindow;
  const held = new Set(spans.flatMap((span) => span.rowIds));
  const appended = hostMessages.slice(EARLIER.length);
  return appended.filter((message) => held.has(message.messageId)).length;
}

const driver: PendingDriver = {
  ready: false,
  press: () => {
    const started = startPendingSend({
      request: {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: PENDING_TEXT,
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
      },
      authority: { hostId: HOST_ID, hostEpoch: 1 },
      senderUserId: VIEWER_ID,
      sentAs: { lifetime: currentBotLifetime(), account: VIEWER_ID },
      text: PENDING_TEXT,
      content: paragraph(PENDING_TEXT),
      images: [],
      release: () => undefined,
    });
    sentRequest = started.request;
  },
  indexNamesPending: () => {
    if (sentRequest === null) throw new Error("nothing was pressed");
    const stored = storedRowOfSend(
      sentRequest,
      VIEWER_ID,
      Date.UTC(2020, 0, 1, 9, 100),
    );
    hostMessages = [...hostMessages, stored];
    rowCount += 1;
    indexRevision += 1;
    indexNamesAppendedRow(session, IDS, {
      rowCount,
      indexRevision,
      entry: userSkeletonEntry(stored.messageId, stored.timestamp),
    });
  },
  indexNamesTeammate: () => {
    const post = teammatePost(TEAMMATE_ID, "A teammate wrote after it.", 101);
    hostMessages = [...hostMessages, post];
    rowCount += 1;
    indexRevision += 1;
    indexNamesAppendedRow(session, IDS, {
      rowCount,
      indexRevision,
      entry: userSkeletonEntry(post.messageId, post.timestamp),
    });
  },
  answerRange: () => {
    if (session.rangeRequests.length <= rangesAnswered) return false;
    answerRangeWith(session, IDS, hostTranscript());
    rangesAnswered = session.rangeRequests.length;
    return true;
  },
  probe: () => {
    const node = scrollNode();
    const nodeRect = node.getBoundingClientRect();
    const rows = memberRows();
    const pending = rows.filter((row) =>
      row.textContent.includes("PENDING-OWN-ROW"),
    );
    const first = pending.at(0)?.getBoundingClientRect() ?? null;
    const anchor = anchorRow();
    return {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      distance: node.scrollHeight - node.clientHeight - node.scrollTop,
      rowsWithPendingText: pending.length,
      pendingTop: first?.top ?? null,
      pendingHeight: first?.height ?? null,
      pendingInView:
        first !== null &&
        first.top >= nodeRect.top &&
        first.bottom <= nodeRect.bottom + 1,
      rowsHanded,
      bodiesHeld: bodiesHeld(),
      teammateRows: rows.filter((row) =>
        row.textContent.includes("A teammate wrote after it."),
      ).length,
      pendingIsLastRow:
        first !== null &&
        rows.every((row) => row.getBoundingClientRect().top <= first.top),
      rangeRequests: session.rangeRequests.length,
      anchorId: anchor?.textContent ?? null,
      anchorTop: anchor?.getBoundingClientRect().top ?? null,
    };
  },
};

driverWindow.__pendingDriver = driver;

export function Channel(): ReactElement {
  const subagentDrillIn = useSubagentDrillIn(true);
  const held = useHeldPendingSends(BOT_ID, CHANNEL_ID);
  const { state, messages, pendingRowIds } = useBotSessionMessages({
    handle: session.handle,
    botId: BOT_ID,
    chatId: CHANNEL_ID,
    viewTabId: "bot-pending-row-follow",
    resolveMember: UNRESOLVED_BOT_MEMBERS,
    held,
  });
  useEffect(() => {
    driver.ready = true;
  }, []);
  useEffect(() => {
    rowsHanded = messages.length;
  }, [messages.length]);
  return (
    <ChatBotPresentationContext.Provider value={PRESENTATION}>
      <ChatBotPendingRowIdsContext value={pendingRowIds}>
        <div className="flex h-screen min-h-0 w-full flex-col bg-background text-foreground">
          <ChatMessages
            taskTitle="Release Bot"
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
            instanceId="bot-pending-row-follow"
            visible
            systemOverlayActive={false}
            scrollRequest={null}
            onScrollRequestSettled={() => undefined}
            composerOverlayHeight={0}
            subagentDrillIn={subagentDrillIn}
          />
        </div>
      </ChatBotPendingRowIdsContext>
    </ChatBotPresentationContext.Provider>
  );
}

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4546,
  systemHostName: "pending-follow-fixture",
  displayName: "pending-follow-fixture",
  availability: "available",
} as const;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => "pending-follow-request",
    handlers: {},
  });

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="pending-follow-fallback" />}
        >
          <WindowsBridgeContext.Provider value={windowsBridgeValue}>
            <TooltipProvider>
              <TabHostContext.Provider value={HOST_ID}>
                <Channel />
              </TabHostContext.Provider>
            </TooltipProvider>
          </WindowsBridgeContext.Provider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}
