/**
 * A bot's post that points into a task (Tracy Bots T89), through the REAL
 * `BotChannelView`: its transcript rows, the surface card under the post,
 * T91's question card it reuses, the channel's link policy and the
 * `bot.surface.act` mutation over a host client whose messenger records the
 * request that leaves. Only the virtualised list is replaced, as in the
 * question-card suite. What is asserted is what the person sees on the card
 * and what the host RECEIVES: the title and state of each kind; Open going
 * where a notification of the surface goes; an answer, a Skip, Allow and
 * Deny going out as the exact action; a recorded action shown at once, a
 * forwarded one held until the post's resolution lands; a refusal said, the
 * answer kept where it can be sent again; a resolved surface offering
 * nothing; an artifact path in the bot's text opening its artifact.
 */
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
  BotInputNeeded,
  BotSurfaceActionState,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotSurfaceActRequest,
  BotSurfaceActResponse,
} from "@traycer/protocol/host/bot/surface-schemas";
import type {
  BotSurfaceReference,
  BotSurfaceResolution,
} from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import type { NotificationPayload } from "@/lib/notifications/payload";
import {
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
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

type TranscriptState = Pick<
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
  handles: new Map<string, ChatSessionStoreHandle>(),
  client: null as HostRequester<HostRpcRegistry> | null,
  unsupported: new Set<string>(),
  navigate: vi.fn(),
  route: vi.fn<(...args: unknown[]) => void>(),
  resolveArtifact:
    vi.fn<(args: unknown) => Promise<ResolveArtifactByPathResult | null>>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => null,
}));
vi.mock("@/lib/notifications/payload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/payload")>()),
  routeNotificationForHost: (...args: unknown[]) => mocks.route(...args),
}));
// The tab-navigation controller holds an activation until the router has
// hydrated; this suite has no router, so the navigate it would issue is
// issued at once, as in the chat link provider's suite.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: (navigate: (intent: unknown) => void, intent: unknown) =>
    navigate(intent),
}));
vi.mock("@/lib/host/resolve-artifact-by-path", () => ({
  fetchResolveArtifactByPath: (args: unknown) => mocks.resolveArtifact(args),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => mocks.handles.get(chatId) ?? null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: (_hostId: string, method: string) =>
    !mocks.unsupported.has(method),
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: [], threadAnchors: null },
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

import { BotChannelView } from "@/components/bots/bot-channel-view";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const TASK_HOST_ID = "host-task";
const CHANNEL_ID = "conversation-channel";
const TASK_ID = "task-deploy";
const AGENT_CHAT_ID = "chat-agent";
const POST_ID = "bot-reply:surface";
const POST_TEXT = "The deploy agent needs your call on the branch.";
const TEAMMATE_USER_ID = "user-teammate";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const resolveMember: BotMemberResolver = (userId) =>
  userId === TEAMMATE_USER_ID
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

const QUESTION: BotSurfaceReference = {
  kind: "question",
  epicId: TASK_ID,
  hostId: TASK_HOST_ID,
  chatId: AGENT_CHAT_ID,
  blockId: "block-interview",
  resolution: null,
};

const APPROVAL: BotSurfaceReference = {
  kind: "approval",
  epicId: TASK_ID,
  hostId: TASK_HOST_ID,
  chatId: AGENT_CHAT_ID,
  approvalId: "approval-publish",
  resolution: null,
};

const BROWSER: BotSurfaceReference = {
  kind: "browser",
  epicId: TASK_ID,
  hostId: TASK_HOST_ID,
  chatId: AGENT_CHAT_ID,
  sessionId: "session-1",
  parkId: "park-1",
  tabId: "tab-1",
  resolution: null,
};

const ARTIFACT: BotSurfaceReference = {
  kind: "artifact",
  epicId: TASK_ID,
  hostId: TASK_HOST_ID,
  artifactPath: "plans/rollout/index.md",
  resolution: null,
};

function surfaceIdOf(surface: BotInputNeeded["surface"]): string {
  switch (surface.kind) {
    case "question":
      return surface.blockId;
    case "approval":
      return surface.approvalId;
    case "browser":
      return surface.parkId;
  }
}

function openItem(surface: BotInputNeeded["surface"]): BotInputNeeded {
  return {
    hostId: TASK_HOST_ID,
    hostName: "Studio Mac",
    agentChatId: AGENT_CHAT_ID,
    surfaceId: surfaceIdOf(surface),
    surface,
    reportedAt: 1_000,
    acceptsActions: true,
  };
}

const OPEN_QUESTION = openItem({
  kind: "question",
  blockId: "block-interview",
  questions: [
    {
      questionId: "q-branch",
      text: "Which branch should I deploy?\nmain is the default.",
      options: ["main", "release"],
      allowsFreeText: true,
    },
  ],
  askedAt: 900,
});

const OPEN_APPROVAL = openItem({
  kind: "approval",
  approvalId: "approval-publish",
  tool: "Bash",
  summary: "npm publish",
  tier: "hard",
  requiresPerson: true,
  askedAt: 900,
});

const OPEN_BROWSER = openItem({
  kind: "browser",
  sessionId: "session-1",
  tabId: "tab-1",
  url: "https://accounts.example.com/login",
  title: "Sign in to Example",
  reason: "Needs your login",
  parkedAt: 1,
  parkId: "park-1",
});

function task(inputNeeded: ReadonlyArray<BotInputNeeded> | null): BotTaskEntry {
  return {
    taskId: TASK_ID,
    cadence: { kind: "on-completion" },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    checkins: null,
    inputNeeded: inputNeeded === null ? null : [...inputNeeded],
  };
}

const NO_IMAGES: Extract<Message, { role: "assistant" }>["imageResolutions"] =
  [];
const rowBlocks = new Map<
  string,
  Extract<Message, { role: "assistant" }>["blocks"]
>();

/** The bot's post in `messageId`, pointing at `surface`; `null` is a plain post, as a host that strips the field serves it. */
function botPost(
  surface: BotSurfaceReference | null,
  text: string,
  messageId: string,
): Message {
  // Each post is its own row: records of one turn share its timestamp.
  const at = 2_000 + [...rowBlocks.keys(), messageId].indexOf(messageId);
  let blocks = rowBlocks.get(messageId);
  if (blocks === undefined) {
    blocks = [
      {
        type: "text",
        blockId: `${messageId}:text`,
        status: "completed",
        timestamp: at,
        text,
        providerNotice: null,
      },
    ];
    rowBlocks.set(messageId, blocks);
  }
  const base: Extract<Message, { role: "assistant" }> = {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "trunk-1",
      displayName: "Release Bot",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: at,
    timestamp: at,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: NO_IMAGES,
  };
  return surface === null ? base : { ...base, surface };
}

/** The post this suite is mostly about. */
function post(surface: BotSurfaceReference | null): Message {
  return botPost(surface, POST_TEXT, POST_ID);
}

function resolved(
  surface: BotSurfaceReference,
  resolution: BotSurfaceResolution,
): BotSurfaceReference {
  return surface.kind === "artifact" ? surface : { ...surface, resolution };
}

function createStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<TranscriptState>> {
  return create<TranscriptState>()(() => ({
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

let acts: ReadonlyArray<BotSurfaceActRequest>;
/** How the tab's host answers each action; a rejection is a host that cannot be reached. */
let answer: () => Promise<BotSurfaceActResponse>;

function hostClientRecordingActs(): HostRequester<HostRpcRegistry> {
  const queryClient = new QueryClient();
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.surface.act": (params) => {
        acts = [...acts, params];
        return answer();
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** The channel as the host serves it; `write` writes rows, `serve` a new subscription snapshot. */
function mountChannel(input: {
  readonly rows: ReadonlyArray<Message>;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly surfaceActions: ReadonlyArray<BotSurfaceActionState> | null;
}): {
  readonly write: (rows: ReadonlyArray<Message>) => void;
  readonly serve: (
    tasks: ReadonlyArray<BotTaskEntry>,
    surfaceActions: ReadonlyArray<BotSurfaceActionState> | null,
  ) => void;
} {
  const store = createStore(input.rows);
  mocks.handles.set(CHANNEL_ID, { store } as ChatSessionStoreHandle);
  const queryClient = new QueryClient();
  const tree = (
    tasks: ReadonlyArray<BotTaskEntry>,
    surfaceActions: ReadonlyArray<BotSurfaceActionState> | null,
  ) => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              botId={BOT_ID}
              hostId={HOST_ID}
              boundHostId={HOST_ID}
              boundHostEpoch={1}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId="trunk-chat"
              resolveMember={resolveMember}
              tasks={tasks}
              surfaceActions={surfaceActions}
              openThread={null}
              onOpenThread={vi.fn()}
              openTurn={null}
              onOpenTurn={vi.fn()}
              onOpenActivity={vi.fn()}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const result = render(tree(input.tasks, input.surfaceActions));
  return {
    write: (rows) => act(() => store.setState({ messages: rows })),
    serve: (tasks, surfaceActions) =>
      result.rerender(tree(tasks, surfaceActions)),
  };
}

function card(): HTMLElement {
  return screen.getByTestId("bot-surface-card");
}

function stateLine(): string | null {
  return (
    within(card()).queryByTestId("bot-surface-card-state")?.textContent ?? null
  );
}

/** Every button the card offers, by its name. */
function cardButtons(): string[] {
  return within(card())
    .queryAllByRole("button")
    .map((button) => button.textContent);
}

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled;
}

/** The task and artifact the one navigation went to. */
function focusedArtifact(): { epicId: string; artifactId: string } | null {
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
  const intent = mocks.navigate.mock.calls[0]?.[0] as {
    readonly epicId: string;
    readonly focus: { readonly focusArtifactId: string };
  };
  return { epicId: intent.epicId, artifactId: intent.focus.focusArtifactId };
}

const SETTLED: BotSurfaceActResponse = { outcome: "settled", code: null };
const FORWARDED: BotSurfaceActResponse = { outcome: "forwarded", code: null };

beforeEach(() => {
  acts = [];
  answer = () => Promise.resolve(SETTLED);
  mocks.handles.clear();
  mocks.unsupported.clear();
  mocks.navigate.mockReset();
  mocks.route.mockReset();
  mocks.resolveArtifact.mockReset();
  rowBlocks.clear();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  useBotSurfaceActionsStore.setState({ entries: {} });
  mocks.client = hostClientRecordingActs();
  signInViewer(VIEWER_USER_ID);
});

afterEach(() => {
  cleanup();
  resetBotFailedRequestSupport();
  mocks.handles.clear();
  mocks.client = null;
});

describe("<BotChannelView /> a post's surface card: what it shows", () => {
  it("draws a question the task's agent waits on: its first line, that it needs an answer, its options, Skip and Open, under the post's text", () => {
    mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    expect(screen.getByText(POST_TEXT)).toBeTruthy();
    expect(
      within(card()).getByTestId("bot-surface-card-title").textContent,
    ).toBe("Which branch should I deploy?");
    expect(stateLine()).toBe("Needs your answer");
    expect(
      within(card())
        .getAllByTestId("question-card-option")
        .map((option) => option.textContent),
    ).toEqual(["main", "release"]);
    expect(cardButtons()).toEqual(
      expect.arrayContaining(["Submit", "Skip", "Open"]),
    );
  });

  it("names what an approval wants, a parked page by its title, and an artifact by its name", () => {
    mountChannel({
      rows: [
        botPost(APPROVAL, "Approve the publish?", "post-approval"),
        botPost(BROWSER, "Sign in for the agent.", "post-browser"),
        botPost(ARTIFACT, "The rollout plan is ready.", "post-artifact"),
      ],
      tasks: [task([OPEN_APPROVAL, OPEN_BROWSER])],
      surfaceActions: [],
    });

    const cards = screen.getAllByTestId("bot-surface-card");
    expect(
      cards.map(
        (each) =>
          within(each).getByTestId("bot-surface-card-title").textContent,
      ),
    ).toEqual([
      "Wants to use Bash: npm publish",
      "Sign in to Example",
      "rollout",
    ]);
    expect(
      cards.map(
        (each) =>
          within(each).queryByTestId("bot-surface-card-state")?.textContent ??
          null,
      ),
    ).toEqual(["Needs your decision", "Waiting for you to sign in", null]);
    expect(
      within(cards[0]).getByRole("button", { name: "Allow" }),
    ).toBeTruthy();
    expect(within(cards[0]).getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(
      within(cards[2])
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Open"]);
  });

  it("shows a settled surface's resolution, by whom, and offers only Open", () => {
    mountChannel({
      rows: [
        post(
          resolved(QUESTION, {
            state: "answered",
            by: { kind: "person", userId: TEAMMATE_USER_ID },
            at: 3_000,
          }),
        ),
      ],
      tasks: [task([])],
      surfaceActions: [],
    });

    expect(stateLine()).toBe("Answered by Tess Teammate");
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("shows Open alone where nothing says whether the surface still waits", () => {
    mountChannel({
      rows: [post(APPROVAL)],
      tasks: [task(null)],
      surfaceActions: null,
    });

    expect(stateLine()).toBeNull();
    expect(
      within(card()).getByTestId("bot-surface-card-title").textContent,
    ).toBe(POST_TEXT);
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("shows Open alone for a page whose session was parked again since the post", () => {
    mountChannel({
      rows: [post(BROWSER)],
      tasks: [
        task([
          openItem({
            kind: "browser",
            sessionId: "session-1",
            tabId: "tab-1",
            url: "https://accounts.example.com/login",
            title: "Sign in to Example",
            reason: "Needs your login",
            parkedAt: 5,
            parkId: "park-2",
          }),
        ]),
      ],
      surfaceActions: [],
    });

    expect(card().getAttribute("data-state")).toBe("unknown");
    expect(stateLine()).toBeNull();
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("shows Open alone, with the state, where the tab's host takes no answer from the card", () => {
    mocks.unsupported.add("bot.surface.act");
    mountChannel({
      rows: [post(APPROVAL)],
      tasks: [task([OPEN_APPROVAL])],
      surfaceActions: [],
    });

    expect(stateLine()).toBe("Needs your decision");
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("draws a post from a host that strips the surface as its text alone", () => {
    mountChannel({
      rows: [post(null)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    expect(screen.getByText(POST_TEXT)).toBeTruthy();
    expect(screen.queryByTestId("bot-surface-card")).toBeNull();
  });
});

describe("<BotChannelView /> a post's surface card: Open", () => {
  it("opens a question, an approval and a parked page where their notifications open them, on the task's machine", async () => {
    const user = userEvent.setup();
    mountChannel({
      rows: [
        botPost(QUESTION, "q", "post-question"),
        botPost(APPROVAL, "a", "post-approval"),
        botPost(BROWSER, "b", "post-browser"),
      ],
      tasks: [task([OPEN_QUESTION, OPEN_APPROVAL, OPEN_BROWSER])],
      surfaceActions: [],
    });

    for (const each of screen.getAllByTestId("bot-surface-card")) {
      await user.click(within(each).getByRole("button", { name: "Open" }));
    }

    const routed = mocks.route.mock.calls.map((call) => ({
      payload: call[1] as NotificationPayload,
      origin: (call[3] as { originHostId: string | null }).originHostId,
    }));
    expect(routed).toEqual([
      {
        payload: {
          kind: "interview",
          epicId: TASK_ID,
          chatId: AGENT_CHAT_ID,
          interviewBlockId: "block-interview",
        },
        origin: TASK_HOST_ID,
      },
      {
        payload: {
          kind: "approval",
          epicId: TASK_ID,
          chatId: AGENT_CHAT_ID,
          approvalId: "approval-publish",
          sessionId: undefined,
          artifactId: undefined,
        },
        origin: TASK_HOST_ID,
      },
      {
        payload: {
          kind: "browserSession",
          epicId: TASK_ID,
          sessionId: "session-1",
          tabId: "tab-1",
        },
        origin: TASK_HOST_ID,
      },
    ]);
    expect(
      mocks.route.mock.calls.every((call) => call[0] === mocks.navigate),
    ).toBe(true);
  });

  it("opens an artifact in its task, focused on it", async () => {
    const user = userEvent.setup();
    mocks.resolveArtifact.mockResolvedValue({
      artifactId: "artifact-rollout",
      kind: "spec",
    });
    mountChannel({
      rows: [post(ARTIFACT)],
      tasks: [task([])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "Open" }));

    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.resolveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: HOST_ID,
        epicId: TASK_ID,
        filePath: `epics/${TASK_ID}/artifacts/plans/rollout/index.md`,
      }),
    );
    expect(focusedArtifact()).toEqual({
      epicId: TASK_ID,
      artifactId: "artifact-rollout",
    });
  });

  it("opens an artifact path in the bot's own text through the channel's link policy", async () => {
    const user = userEvent.setup();
    mocks.resolveArtifact.mockResolvedValue({
      artifactId: "artifact-plan",
      kind: "spec",
    });
    const path = `/Users/olive/.traycer/epics/${TASK_ID}/artifacts/plan/index.md`;
    mountChannel({
      rows: [botPost(null, `The plan is in [the plan](${path}).`, POST_ID)],
      tasks: [],
      surfaceActions: null,
    });

    await user.click(screen.getByRole("link", { name: "the plan" }));

    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.resolveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: TASK_ID, filePath: path }),
    );
    expect(focusedArtifact()).toEqual({
      epicId: TASK_ID,
      artifactId: "artifact-plan",
    });
  });
});

describe("<BotChannelView /> a post's surface card: answering and deciding", () => {
  it("sends the picked option as the answer the task's own card sends, and shows it answered at once when the tab's host records it", async () => {
    const user = userEvent.setup();
    mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "release" }));
    await user.click(within(card()).getByRole("button", { name: "Submit" }));

    expect(acts).toHaveLength(1);
    const actionId = acts[0]?.actionId ?? "";
    expect(actionId).toMatch(UUID);
    expect(acts[0]).toEqual({
      botId: BOT_ID,
      messageId: POST_ID,
      actionId,
      surface: QUESTION,
      action: {
        kind: "answer",
        answers: [
          {
            questionId: "q-branch",
            question: "Which branch should I deploy?\nmain is the default.",
            values: ["release"],
            notes: null,
            selection: {
              questionIndex: 0,
              optionIndices: [1],
              optionLabels: ["release"],
              customText: null,
            },
          },
        ],
      },
    });
    await vi.waitFor(() => expect(stateLine()).toBe("Answered by you"));
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("sends Skip as the task's Skip", async () => {
    const user = userEvent.setup();
    mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "Skip" }));

    expect(acts.map((each) => each.action)).toEqual([
      { kind: "skip", draftAnswers: [] },
    ]);
    await vi.waitFor(() => expect(stateLine()).toBe("Skipped by you"));
  });

  it("sends Allow and Deny as the approval's decision", async () => {
    const user = userEvent.setup();
    mountChannel({
      rows: [
        botPost(APPROVAL, "first", "post-allow"),
        botPost(
          { ...APPROVAL, approvalId: "approval-second" },
          "second",
          "post-deny",
        ),
      ],
      tasks: [
        task([
          OPEN_APPROVAL,
          openItem({
            kind: "approval",
            approvalId: "approval-second",
            tool: "Bash",
            summary: "rm -rf build",
            tier: null,
            requiresPerson: false,
            askedAt: 900,
          }),
        ]),
      ],
      surfaceActions: [],
    });

    const [allowCard, denyCard] = screen.getAllByTestId("bot-surface-card");
    await user.click(within(allowCard).getByRole("button", { name: "Allow" }));
    await user.click(within(denyCard).getByRole("button", { name: "Deny" }));

    expect(
      acts.map((each) => ({ messageId: each.messageId, action: each.action })),
    ).toEqual([
      {
        messageId: "post-allow",
        action: { kind: "decide", decision: { approved: true } },
      },
      {
        messageId: "post-deny",
        action: { kind: "decide", decision: { approved: false } },
      },
    ]);
    await vi.waitFor(() =>
      expect(
        within(denyCard).getByTestId("bot-surface-card-state").textContent,
      ).toBe("Denied by you"),
    );
  });

  it("holds a decision sent on to the task's machine as sending until the post's resolution lands", async () => {
    const user = userEvent.setup();
    answer = () => Promise.resolve(FORWARDED);
    const channel = mountChannel({
      rows: [post(APPROVAL)],
      tasks: [task([OPEN_APPROVAL])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "Allow" }));
    await vi.waitFor(() =>
      expect(card().getAttribute("data-state")).toBe("sending"),
    );
    const actionId = acts[0]?.actionId ?? "";
    channel.serve(
      [task([OPEN_APPROVAL])],
      [{ actionId, messageId: POST_ID, state: "sending", code: null }],
    );
    expect(card().getAttribute("data-state")).toBe("sending");
    expect(
      isDisabled(within(card()).getByRole("button", { name: /Allow/ })),
    ).toBe(true);
    expect(within(card()).getByTestId("bot-surface-card-sending")).toBeTruthy();

    channel.write([
      post(
        resolved(APPROVAL, {
          state: "allowed",
          by: { kind: "person", userId: VIEWER_USER_ID },
          at: 4_000,
        }),
      ),
    ]);
    channel.serve([task([])], []);

    expect(stateLine()).toBe("Allowed by you");
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("keeps the answer when the task's machine cannot be reached, and sends it again as a new action", async () => {
    const user = userEvent.setup();
    answer = () => Promise.resolve(FORWARDED);
    const channel = mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "main" }));
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    await vi.waitFor(() =>
      expect(card().getAttribute("data-state")).toBe("sending"),
    );
    const actionId = acts[0]?.actionId ?? "";
    channel.serve(
      [task([OPEN_QUESTION])],
      [
        {
          actionId,
          messageId: POST_ID,
          state: "refused",
          code: "NOT_REACHABLE",
        },
      ],
    );

    await vi.waitFor(() =>
      expect(stateLine()).toBe("Couldn't reach the task. Your answer is kept."),
    );
    const main = within(card()).getByRole("button", { name: "main" });
    expect(main.getAttribute("aria-pressed")).toBe("true");
    const submit = within(card()).getByRole("button", { name: "Submit" });
    expect(isDisabled(submit)).toBe(false);

    answer = () => Promise.resolve(SETTLED);
    await user.click(submit);
    expect(acts).toHaveLength(2);
    expect(acts[1]?.actionId).toMatch(UUID);
    expect(acts[1]?.actionId).not.toBe(actionId);
    expect(acts[1]?.action).toEqual(acts[0]?.action);
  });

  it("sends an answer again as a new action once the tab's host reports the unanswered one refused", async () => {
    const user = userEvent.setup();
    answer = () => Promise.reject(new Error("socket closed"));
    const channel = mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "main" }));
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    await vi.waitFor(() =>
      expect(stateLine()).toBe("Couldn't reach the task. Your answer is kept."),
    );
    const actionId = acts[0]?.actionId ?? "";
    channel.serve(
      [task([OPEN_QUESTION])],
      [
        {
          actionId,
          messageId: POST_ID,
          state: "refused",
          code: "NOT_REACHABLE",
        },
      ],
    );

    answer = () => Promise.resolve(SETTLED);
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    expect(acts).toHaveLength(2);
    expect(acts[1]?.actionId).toMatch(UUID);
    expect(acts[1]?.actionId).not.toBe(actionId);
  });

  it("sends an answer again as a new action after the tab's host says the task cannot be reached", async () => {
    const user = userEvent.setup();
    answer = () =>
      Promise.resolve({ outcome: "refused", code: "NOT_REACHABLE" });
    mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "main" }));
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    await vi.waitFor(() =>
      expect(stateLine()).toBe("Couldn't reach the task. Your answer is kept."),
    );

    answer = () => Promise.resolve(SETTLED);
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    expect(acts).toHaveLength(2);
    expect(acts[1]?.actionId).toMatch(UUID);
    expect(acts[1]?.actionId).not.toBe(acts[0]?.actionId);
    await vi.waitFor(() => expect(stateLine()).toBe("Answered by you"));
  });

  it("sends an answer again as the same action when the tab's host gave no answer, keeping it meanwhile", async () => {
    const user = userEvent.setup();
    answer = () => Promise.reject(new Error("socket closed"));
    mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "release" }));
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    await vi.waitFor(() =>
      expect(stateLine()).toBe("Couldn't reach the task. Your answer is kept."),
    );
    expect(
      within(card())
        .getByRole("button", { name: "release" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    answer = () => Promise.resolve(SETTLED);
    await user.click(within(card()).getByRole("button", { name: "Submit" }));
    expect(acts.map((each) => each.actionId)).toEqual([
      acts[0]?.actionId,
      acts[0]?.actionId,
    ]);
    expect(acts[1]?.action).toEqual(acts[0]?.action);
  });

  it("offers a decision again when the tab's own host does not answer", async () => {
    const user = userEvent.setup();
    answer = () => Promise.reject(new Error("socket closed"));
    mountChannel({
      rows: [post(APPROVAL)],
      tasks: [task([OPEN_APPROVAL])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "Deny" }));

    await vi.waitFor(() =>
      expect(stateLine()).toBe("Couldn't reach the task."),
    );
    expect(
      isDisabled(within(card()).getByRole("button", { name: "Allow" })),
    ).toBe(false);
  });

  it("says to answer in the task, and offers Open, when the task's machine takes no answer from here", async () => {
    const user = userEvent.setup();
    answer = () =>
      Promise.resolve({ outcome: "refused", code: "NOT_SUPPORTED" });
    mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "Skip" }));

    await vi.waitFor(() =>
      expect(stateLine()).toBe("Answer this in the task."),
    );
    expect(cardButtons()).toEqual(["Open"]);
  });

  it("shows an answer the task already took as answered, and then its resolution, when sent again after a restart", async () => {
    const user = userEvent.setup();
    answer = () =>
      Promise.resolve({ outcome: "refused", code: "ALREADY_SETTLED" });
    const channel = mountChannel({
      rows: [post(QUESTION)],
      tasks: [task([OPEN_QUESTION])],
      surfaceActions: [],
    });

    await user.click(within(card()).getByRole("button", { name: "main" }));
    await user.click(within(card()).getByRole("button", { name: "Submit" }));

    await vi.waitFor(() => expect(stateLine()).toBe("Already answered"));
    expect(cardButtons()).toEqual(["Open"]);
    channel.write([
      post(
        resolved(QUESTION, {
          state: "answered",
          by: { kind: "person", userId: VIEWER_USER_ID },
          at: 4_000,
        }),
      ),
    ]);
    expect(stateLine()).toBe("Answered by you");
  });
});
