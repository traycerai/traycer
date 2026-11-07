/**
 * A bot's messages with other bots (Tracy Bots T126), through the REAL
 * `BotChannelView`: the bot's own Communication Graph feed is seeded through
 * the cloud subscription opener (the stream the office view reads), the
 * production hook classifies it, and the lines and the pair's log are what the
 * view hands the transcript and the rail. Only the virtualised message list is
 * replaced, by a stub that runs the list builder on the exchanges the view
 * provides and draws each row through the real `<ChatMessage>`.
 */
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import {
  botRecordSchema,
  type BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { HostRpcRegistry } from "@/lib/host";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  OTHER_BOT_ID,
  OTHER_BOT_TITLE,
  THREAD_ID,
  THREAD_OPEN,
  THREAD_SESSION_ID,
  TRUNK_ID,
  buildScene,
  hostClientLocating,
  type Scene,
} from "@/components/bots/__tests__/bot-turn-test-support";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
}));

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
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
  useExistingChatSessionHandle: (
    _epicId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
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
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
// The feed's transport and host directory: the opener override below stands
// in for the relay.
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => vi.fn(),
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use, useState } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { BotExchangeLinesContext } =
    await import("@/components/chat/bot-exchange-lines-context");
  const { createBotExchangeLineCollator } =
    await import("@/stores/chats/transcript-exchange-lines");
  const { transcriptListRows } =
    await import("@/stores/chats/transcript-list-rows");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => {
      const [collateExchangeLines] = useState(createBotExchangeLineCollator);
      const rows = collateExchangeLines(
        transcriptListRows({
          window: null,
          rendered: props.messages,
          splitLongTurns: false,
        }),
        use(BotExchangeLinesContext)?.exchanges ?? [],
      );
      return (
        <Providers tileInstanceId={props.instanceId}>
          <div
            data-testid="chat-messages-stub"
            data-instance-id={props.instanceId}
          >
            {rows.map((row) =>
              row.kind === "hydrated" ? (
                <div
                  key={row.key}
                  data-testid="stub-row"
                  data-row-key={row.key}
                >
                  <ChatMessage
                    message={row.model}
                    actions={null}
                    backgroundToolBlockIds={noBackgroundToolBlockIds}
                    nextStepActions={null}
                  />
                </div>
              ) : null,
            )}
          </div>
        </Providers>
      );
    },
  };
});

import { BotChannelView } from "@/components/bots/bot-channel-view";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import type {
  BotExchangeRail,
  BotOpenExchange,
  BotOpenThread,
} from "@/stores/bots/bot-open-thread-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { __setCommGraphCloudSubscriptionOpenerForTests } from "@/lib/comm-graph/comm-graph-opener-override";
import { __resetCommGraphCloudRegistryForTests } from "@/lib/comm-graph/comm-graph-cloud-registry";
import { __resetCommGraphRegistryForTests } from "@/lib/comm-graph/comm-graph-registry";
import { __setCommGraphDataCommitWindowMsForTests } from "@/lib/comm-graph/comm-graph-data-commit-window";
import type { CommGraphCloudSubscriptionRequest } from "@/lib/comm-graph/comm-graph-cloud-subscription";
import { useCommGraphTimelineStore } from "@/stores/epics/comm-graph-timeline-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { publishEnvironmentArmScope } from "@/hooks/environment/use-environment-arms";
import {
  PoolArmClient,
  eventsFrame,
} from "@/hooks/environment/__tests__/arm-pool-test-support";

const BOUND_HOST_ID = "host-runs-bot";
const DOCS_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROFILE = {
  userId: "user-viewer",
  userName: "U",
  email: "u@example.com",
};
const CONTEXT = { userId: "user-viewer", username: "U" };
const resolveMember: BotMemberResolver = () => null;

function botRecord(botId: string, title: string): BotRecord {
  return botRecordSchema.parse({
    botId,
    environmentId: "env-1",
    createdByUserId: null,
    title,
    harness: "claude",
    model: "claude-sonnet-4",
    effort: null,
    profile: null,
    trunkChatId: `trunk-of-${botId}`,
    boundHostId: BOUND_HOST_ID,
    hostEpoch: 1,
    createdAt: 1,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  });
}

const AUDIT_BOT = botRecord(OTHER_BOT_ID, OTHER_BOT_TITLE);
const ENVIRONMENT_BOTS: ReadonlyArray<BotRecord> = [AUDIT_BOT];

/**
 * A feed row as the host writes each side of a message. `sent`: the bot's
 * `session` wrote it, and the mirror has no origin. `received`: the other
 * bot's session wrote it to the bot's `session`, and the row is promoted from
 * the delivery with that session as its origin chat.
 */
function feedRow(input: {
  readonly version: number;
  readonly at: number;
  readonly session: string;
  readonly direction: "sent" | "received";
  readonly peer: string;
  readonly text: string;
  readonly responseId: string;
  readonly inReplyTo: string | null;
}): HostCommunicationGraphCloudFeedEvent {
  const sent = input.direction === "sent";
  return {
    eventId: `event-${String(input.version)}`,
    originHostId: BOUND_HOST_ID,
    originSequence: input.version,
    ingestVersion: input.version,
    kind: "a2a_message",
    capturedAt: input.at,
    senderAgentId: sent
      ? input.session
      : `peer-session-${String(input.version)}`,
    receiverAgentId: sent
      ? `peer-session-${String(input.version)}`
      : input.session,
    responseId: input.responseId,
    inReplyTo: input.inReplyTo,
    expectReply: input.inReplyTo === null,
    messageText: input.text,
    noticeReason: null,
    originKind: sent ? null : "gui_message",
    originChatId: sent ? null : input.session,
    originRefId: sent ? null : `receipt-${String(input.version)}`,
    peerEpicId: input.peer,
    historicalUpload: false,
  };
}

/** Between the member's post (1_000) and the bot's reply (2_000). */
const ASKED = feedRow({
  version: 1,
  at: 1_500,
  session: TRUNK_ID,
  direction: "sent",
  peer: OTHER_BOT_ID,
  text: "Is the **nightly** red?",
  responseId: "r-1",
  inReplyTo: null,
});
const ANSWERED = feedRow({
  version: 2,
  at: 1_600,
  session: TRUNK_ID,
  direction: "received",
  peer: OTHER_BOT_ID,
  text: "Yes, lint failed.",
  responseId: "r-1",
  inReplyTo: "r-1",
});
/** After the bot's reply: a trailing line. */
const DOCS_ASKED = feedRow({
  version: 3,
  at: 2_500,
  session: TRUNK_ID,
  direction: "sent",
  peer: DOCS_BOT_ID,
  text: "Docs check, please.",
  responseId: "r-2",
  inReplyTo: null,
});
/** Sent by the open thread's session, not the trunk. */
const THREAD_ASKED = feedRow({
  version: 4,
  at: 3_500,
  session: THREAD_SESSION_ID,
  direction: "sent",
  peer: OTHER_BOT_ID,
  text: "Thread question for audit.",
  responseId: "r-3",
  inReplyTo: null,
});

/**
 * Sent by a session that is neither the trunk nor the open thread's (a
 * thread's earlier session, before it was resumed), among the trunk's rows.
 */
const EARLIER_SESSION_ASKED = feedRow({
  version: 6,
  at: 1_550,
  session: "session-before-resume",
  direction: "sent",
  peer: OTHER_BOT_ID,
  text: "Question from a session no surface shows.",
  responseId: "r-6",
  inReplyTo: null,
});

let scene: Scene;
let requests: CommGraphCloudSubscriptionRequest[];

beforeEach(() => {
  __setCommGraphDataCommitWindowMsForTests(0);
  useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  __resetCommGraphCloudRegistryForTests();
  __resetCommGraphRegistryForTests();
  useBotOpenThreadStore.setState({ byBotId: {} });
  scene = buildScene();
  mocks.sessions = scene.sessions;
  mocks.threads = scene.threads;
  mocks.client = hostClientLocating(() => ({ turns: [] }), []);
  requests = [];
  __setCommGraphCloudSubscriptionOpenerForTests((request) => {
    requests.push(request);
    return { close: vi.fn() };
  });
});

afterEach(() => {
  cleanup();
  publishEnvironmentArmScope(null);
  useAuthStore.getState().setSignedOut();
  __setCommGraphCloudSubscriptionOpenerForTests(null);
  __resetCommGraphCloudRegistryForTests();
  __resetCommGraphRegistryForTests();
  __setCommGraphDataCommitWindowMsForTests(null);
  mocks.sessions = {};
  mocks.client = null;
});

interface ChannelProps {
  readonly environmentBots: ReadonlyArray<BotRecord> | null;
  readonly openExchange: BotOpenExchange | null;
  readonly openThread: BotOpenThread | null;
}

function Channel(
  props: ChannelProps & {
    readonly rail: BotExchangeRail;
    readonly queryClient: QueryClient;
  },
) {
  return (
    <QueryClientProvider client={props.queryClient}>
      <BotTestRunnerHost>
        <TooltipProvider>
          <BotIdentityContext
            value={{ botId: BOT_ID, title: "Release Bot", owner: null }}
          >
            <BotChannelView
              botId={BOT_ID}
              hostId={HOST_ID}
              boundHostId={BOUND_HOST_ID}
              boundHostEpoch={1}
              tiles={null}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId={TRUNK_ID}
              resolveMember={resolveMember}
              tasks={[]}
              surfaceActions={null}
              openThread={props.openThread}
              onOpenThread={() => undefined}
              onOpenTurn={() => undefined}
              onOpenSession={() => undefined}
              landOn={null}
              openMemory={null}
              onOpenMemory={() => undefined}
              environmentId="env-1"
              botNameOf={() => null}
              environmentBots={props.environmentBots}
              openExchange={props.openExchange}
              exchangeRail={props.rail}
              setupHistory={null}
            />
          </BotIdentityContext>
        </TooltipProvider>
      </BotTestRunnerHost>
    </QueryClientProvider>
  );
}

function mount(props: ChannelProps) {
  const open = vi.fn<(peerBotId: string) => void>();
  const rail: BotExchangeRail = { open, close: vi.fn() };
  const queryClient = new QueryClient();
  const view = render(
    <Channel {...props} rail={rail} queryClient={queryClient} />,
  );
  return {
    open,
    rerender: (next: ChannelProps) =>
      view.rerender(
        <Channel {...next} rail={rail} queryClient={queryClient} />,
      ),
  };
}

const NO_EXCHANGE_OPEN: ChannelProps = {
  environmentBots: ENVIRONMENT_BOTS,
  openExchange: null,
  openThread: null,
};

/** The feed's relay answers: its history, then caught up (or not yet). */
async function feedHolds(
  events: ReadonlyArray<HostCommunicationGraphCloudFeedEvent>,
  options: { readonly caughtUp: boolean },
): Promise<CommGraphCloudSubscriptionRequest> {
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  const request = requests[0];
  act(() => {
    request.handlers.onAvailability("available");
    request.handlers.onSnapshot(events, 4, null);
    if (options.caughtUp) {
      request.handlers.onCaughtUp({ ingestVersion: 4, eventId: "event-4" }, 4);
    }
  });
  return request;
}

function list(instanceId: string): HTMLElement {
  const element = document.querySelector(`[data-instance-id="${instanceId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${instanceId}`);
  return element;
}

function channelRows(): ReadonlyArray<string> {
  return within(list(`bot-channel:${BOT_ID}`))
    .getAllByTestId("stub-row")
    .map((row) => {
      const key = row.getAttribute("data-row-key") ?? "";
      const pair = within(row).queryAllByTestId("bot-exchange-pair");
      return pair.length === 0
        ? key
        : pair.map((button) => button.textContent).join(" | ");
    });
}

describe("a bot's channel with its messages to other bots", () => {
  it("draws the bot's messages with another bot as lines between the rows they fall between", async () => {
    mount(NO_EXCHANGE_OPEN);

    await feedHolds([ASKED, ANSWERED, DOCS_ASKED, THREAD_ASKED], {
      caughtUp: true,
    });

    await waitFor(() =>
      expect(channelRows()).toEqual([
        "post-1",
        "Release Bot ↔ Audit Bot · 2 messages",
        expect.stringMatching(/^assistant:/),
        "Release Bot ↔ a removed bot · 1 message",
      ]),
    );
  });

  it("names the pair in the line and opens its log when pressed", async () => {
    const { open } = mount(NO_EXCHANGE_OPEN);
    await feedHolds([ASKED, ANSWERED], { caughtUp: true });

    const pair = await within(list(`bot-channel:${BOT_ID}`)).findByTestId(
      "bot-exchange-pair",
    );
    await userEvent.setup().click(pair);

    expect(open).toHaveBeenCalledExactlyOnceWith(OTHER_BOT_ID);
  });

  it("draws no line from the feed's history until it has caught up", async () => {
    mount(NO_EXCHANGE_OPEN);
    const request = await feedHolds([ASKED], { caughtUp: false });
    const channel = list(`bot-channel:${BOT_ID}`);

    expect(within(channel).queryByTestId("bot-exchange-line")).toBeNull();

    act(() =>
      request.handlers.onCaughtUp({ ingestVersion: 4, eventId: "event-4" }, 4),
    );
    await within(channel).findByTestId("bot-exchange-line");
  });

  it("draws no line while a team environment's arm has not answered, though the graph's own readiness is the viewer feed's", async () => {
    const pool = new PoolArmClient();
    publishEnvironmentArmScope({
      poolHostId: "pool-host-id",
      client: pool,
      viewerId: "viewer-1",
      environmentIds: ["env-team"],
      environmentIdByTeamId: new Map(),
      supported: new Set(["environment.communicationGraph.subscribe"]),
    });
    mount(NO_EXCHANGE_OPEN);
    // What the office canvas and the detail panel read, over the same feed.
    const graph = renderHook(() =>
      useCommGraphSnapshot(BOT_ID, [BOUND_HOST_ID], HOST_ID),
    );
    await feedHolds([ASKED, ANSWERED], { caughtUp: true });
    const channel = list(`bot-channel:${BOT_ID}`);

    expect(pool.armSessions).toHaveLength(1);
    expect(graph.result.current.initialHistoryCaughtUp).toBe(true);
    expect(within(channel).queryByTestId("bot-exchange-line")).toBeNull();

    act(() => {
      pool.armSessions[0].emit(
        eventsFrame({
          epicId: BOT_ID,
          generation: 0,
          events: [],
          caughtUp: true,
        }),
        null,
      );
    });

    await within(channel).findByTestId("bot-exchange-line");
  });

  it("draws no line until the environment's bots are listed, which name the pair", async () => {
    const { rerender } = mount({ ...NO_EXCHANGE_OPEN, environmentBots: null });
    await feedHolds([ASKED], { caughtUp: true });
    const channel = list(`bot-channel:${BOT_ID}`);

    expect(within(channel).queryByTestId("bot-exchange-line")).toBeNull();

    rerender(NO_EXCHANGE_OPEN);
    await within(channel).findByTestId("bot-exchange-line");
  });

  it("folds a message that arrives live into the trailing line", async () => {
    mount(NO_EXCHANGE_OPEN);
    const request = await feedHolds([DOCS_ASKED], { caughtUp: true });
    const channel = list(`bot-channel:${BOT_ID}`);
    await within(channel).findByText(/a removed bot · 1 message/);

    act(() =>
      request.handlers.onEvent(
        feedRow({
          version: 5,
          at: 2_600,
          session: TRUNK_ID,
          direction: "received",
          peer: DOCS_BOT_ID,
          text: "On it.",
          responseId: "r-2",
          inReplyTo: "r-2",
        }),
      ),
    );

    await within(channel).findByText(/a removed bot · 2 messages/);
    expect(within(channel).getAllByTestId("bot-exchange-line")).toHaveLength(1);
  });

  it("draws each session's messages on its own surface, and a session shown by neither on neither", async () => {
    mount({ ...NO_EXCHANGE_OPEN, openThread: THREAD_OPEN });
    await feedHolds([ASKED, THREAD_ASKED, EARLIER_SESSION_ASKED], {
      caughtUp: true,
    });

    const thread = await within(list(`bot-thread:${THREAD_ID}`)).findByTestId(
      "bot-exchange-pair",
    );
    expect(thread.textContent).toBe("Release Bot ↔ Audit Bot · 1 message");
    const channel = within(list(`bot-channel:${BOT_ID}`));
    expect(channel.getByTestId("bot-exchange-pair").textContent).toBe(
      "Release Bot ↔ Audit Bot · 1 message",
    );
  });
});

describe("the log of a pair, open in the rail", () => {
  it("lists the pair's messages oldest first with who sent each, and the message a reply answers", async () => {
    mount({
      ...NO_EXCHANGE_OPEN,
      openExchange: { peerBotId: OTHER_BOT_ID, back: null },
    });
    await feedHolds([ASKED, ANSWERED, DOCS_ASKED, THREAD_ASKED], {
      caughtUp: true,
    });

    const log = within(await screenLog());
    const rows = await log.findAllByTestId("bot-exchange-log-row");

    expect(
      rows.map((row) => [
        row.getAttribute("data-direction"),
        within(row).queryByTestId("bot-exchange-log-reply")?.textContent ??
          null,
      ]),
    ).toEqual([
      ["sent", null],
      ["received", expect.stringMatching(/^Replying to Release Bot, /)],
      ["sent", null],
    ]);
    expect(rows[0].textContent).toContain("Release Bot");
    expect(within(rows[0]).getByText("nightly").tagName).toBe("STRONG");
    expect(rows[1].textContent).toContain("Audit Bot");
    expect(rows[1].textContent).toContain("Yes, lint failed.");
  });

  it("lists a message of a session that neither the channel nor a thread shows", async () => {
    mount({
      ...NO_EXCHANGE_OPEN,
      openExchange: { peerBotId: OTHER_BOT_ID, back: null },
    });
    await feedHolds([ASKED, EARLIER_SESSION_ASKED], { caughtUp: true });

    const rows = await within(await screenLog()).findAllByTestId(
      "bot-exchange-log-row",
    );

    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Is the nightly red?"),
      expect.stringContaining("Question from a session no surface shows."),
    ]);
    expect(
      within(list(`bot-channel:${BOT_ID}`)).getByTestId("bot-exchange-pair")
        .textContent,
    ).toBe("Release Bot ↔ Audit Bot · 1 message");
  });

  it("shows another pair's messages in its place when another pair is chosen", async () => {
    const { rerender } = mount({
      ...NO_EXCHANGE_OPEN,
      openExchange: { peerBotId: OTHER_BOT_ID, back: null },
    });
    await feedHolds([ASKED, ANSWERED, DOCS_ASKED], { caughtUp: true });
    await within(await screenLog()).findAllByTestId("bot-exchange-log-row");

    rerender({
      ...NO_EXCHANGE_OPEN,
      openExchange: { peerBotId: DOCS_BOT_ID, back: null },
    });

    const log = within(await screenLog());
    const rows = await log.findAllByTestId("bot-exchange-log-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Docs check, please.");
    expect(log.getByRole("heading").textContent).toContain("a removed bot");
  });
});

function screenLog(): Promise<HTMLElement> {
  return waitFor(() => {
    const log = document.querySelector('[data-testid="bot-exchange-log"]');
    if (!(log instanceof HTMLElement)) throw new Error("no log");
    return log;
  });
}
