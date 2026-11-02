/**
 * A post the bot did not answer, and the routing card above its box,
 * through the REAL `BotChannelView` and `BotThreadPanel`: where
 * the session that answers the surface (the trunk beside the channel, a
 * thread's session in its panel) names the post's turn as its last failed
 * attempt, the row says why in the agent chat's words and offers the agent
 * chat's own actions; otherwise it keeps the bot's Retry and Edit. The
 * session's `pendingFallback` draws the agent chat's routing card above the
 * surface's box. Only the virtualised list, the session registry (scripted
 * sessions by chat id), the picker and the mutation behind the actions are
 * replaced.
 */
import { type ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type {
  BotThreadSummary,
  BotTurnLocateRequest,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import {
  BOT_ID,
  CHANNEL_ID,
  ENDED_AT,
  POST_FIRST_LINE,
  POST_ID,
  POST_REQUEST,
  POST_SECOND_LINE,
  STARTED_AT,
  SUMMARY,
  THREAD_ID,
  THREAD_OPEN,
  THREAD_SESSION_ID,
  TOOK,
  TRUNK_ID,
  buildScene,
  hostClientLocating,
  memberPost,
  turnRef,
  openedSessions,
  turnsAskedFor,
  type Scene,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  lastFailedAttempt,
  pendingFallback,
} from "@/components/chat/fallback/__tests__/fallback-fixtures";
import type { RoutingDestinationPicker } from "@/components/chat/fallback/routing-destination-picker";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import type { HostRpcRegistry } from "@/lib/host";
import { formatClockTime } from "@/lib/relative-time";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  useBotOpenThreadStore,
  type BotOpenThread,
} from "@/stores/bots/bot-open-thread-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
  /** Every manual rung the agent chat's actions asked the host for. */
  rungs: [] as Array<unknown>,
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
  useHostSupportsMethod: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
  usePaneFocused: () => true,
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
  useBotActivity: () => activityStore((state) => state.activity),
}));
// The agent chat's actions and card, over their own boundaries: the model
// labels pass the slug through, the chooser is a button, the mutation records
// the rung it was asked for, and nothing else leaves the renderer.
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/chat/fallback/fallback-identity")
    >()),
    useFallbackModelLabels: () => (_harnessId: string, model: string) => model,
  }),
);
vi.mock("@/components/chat/fallback/routing-destination-picker", () => ({
  RoutingDestinationPicker: (
    props: ComponentProps<typeof RoutingDestinationPicker>,
  ) => (
    <button type="button" disabled={props.triggerDisabled || !props.canAct}>
      {props.triggerLabel}
    </button>
  ),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ label: "Studio Mac" }),
}));
vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: (variables: unknown) => {
      mocks.rungs.push(variables);
    },
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div
          data-testid="chat-messages-stub"
          data-instance-id={props.instanceId}
        >
          {use(ChatTimelineHeaderContext)}
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

/** What the bot is doing, as the scripted `useBotActivity` reads it. */
const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));

const FAILED_TURN_ID = "turn-failed";
const FAILED_PROMPT_ID = "prompt-failed";
const BOT_OWN_REASON = "The provider returned an error";

/** Mounts the channel with `rail` open beside it, or nothing (`null`). */
function mountChannel(rail: BotOpenThread | null): void {
  if (rail !== null) {
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, { kind: "thread", ...rail });
  }
  render(<MountedChannel />);
}

let scene: Scene;
let asked: BotTurnLocateRequest[];

/** The turn of `chatId` that failed answering the post. */
function failedTurn(chatId: string, threadId: string | null): BotTurnRef {
  return turnRef({
    chatId,
    turnId: FAILED_TURN_ID,
    userMessageId: FAILED_PROMPT_ID,
    threadId,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    summary: SUMMARY,
    messageIds: [],
    requestIds: [POST_REQUEST],
  });
}

/** The bot's session `state` for the post, with the reason the bot itself gives. */
function failedSession(requestId: string) {
  return {
    state: "failed" as const,
    startedAt: STARTED_AT,
    step: null,
    requestId,
    reason: {
      code: null,
      summary: BOT_OWN_REASON,
      harnessId: "claude",
      action: "none" as const,
    },
  };
}

/** The post is the viewer's own and unanswered; the trunk failed on it. */
function failPostOnTrunk(): void {
  scene.channel.setState({
    messages: [
      memberPost({
        messageId: POST_ID,
        requestId: POST_REQUEST,
        lines: [POST_FIRST_LINE, POST_SECOND_LINE],
        timestamp: 1_000,
        resolvedBy: null,
      }),
    ],
  });
  activityStore.setState({
    activity: { trunk: failedSession(POST_REQUEST), threads: {} },
  });
}

/** The session's last failed attempt is the turn that failed the post, a rate limit that resets in an hour. */
function nameAttempt(session: Scene["trunk"], resetsAt: number): void {
  session.setState({
    lastFailedAttempt: lastFailedAttempt({
      userMessageId: FAILED_PROMPT_ID,
      turnId: FAILED_TURN_ID,
      failure: { reason: "rate_limit", resetsAt, resetsAtSource: "provider" },
      eligibleRungs: ["retry", "switch", "wait_once"],
      waitDisposition: "eligible",
      switchDisposition: "eligible",
      failedTuple: FAILED_CLAUDE_TUPLE,
    }),
  });
}

function memberRow(): HTMLElement {
  return within(screen.getByTestId("bot-channel")).getByTestId(
    "bot-member-row",
  );
}

beforeEach(() => {
  asked = [];
  mocks.rungs = [];
  activityStore.setState({ activity: null });
  useBotOpenThreadStore.setState({ byBotId: {} });
  openedSessions.length = 0;
  scene = buildScene();
  scene.knownTurns = [failedTurn(TRUNK_ID, null)];
  mocks.sessions = scene.sessions;
  mocks.threads = scene.threads;
  mocks.client = hostClientLocating(
    (request) => turnsAskedFor(scene.knownTurns, request),
    asked,
  );
  negotiateBotSend("host-tab", { major: 1, minor: 1 });
  signInViewer(VIEWER_USER_ID);
});

afterEach(() => {
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  cleanup();
  resetBotFailedRequestSupport();
  mocks.sessions = {};
  mocks.client = null;
});

describe("a post the trunk failed to answer", () => {
  it("says why in the agent chat's words and offers its Switch to…, Wait until and Retry, with the bot's own Retry gone and Edit kept", async () => {
    const resetsAt = Date.now() + 3_600_000;
    failPostOnTrunk();
    nameAttempt(scene.trunk, resetsAt);
    mountChannel(null);

    const actions = await screen.findByTestId("failed-turn-actions");

    expect(
      within(memberRow()).getByTestId("bot-message-unanswered").textContent,
    ).toContain(`Not answered: ${FALLBACK_REASON_LABELS.rate_limit}`);
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Switch to…",
      `Wait until ${formatClockTime(resetsAt)}`,
      "Retry",
    ]);
    expect(
      within(memberRow()).queryByTestId("bot-message-unanswered-retry"),
    ).toBeNull();
    expect(
      within(memberRow()).getByTestId("bot-message-unanswered-edit"),
    ).toBeTruthy();
  });

  it("runs the agent chat's Retry on the trunk's failed turn", async () => {
    const user = userEvent.setup();
    failPostOnTrunk();
    nameAttempt(scene.trunk, Date.now() + 3_600_000);
    mountChannel(null);

    await user.click(
      within(await screen.findByTestId("failed-turn-actions")).getByRole(
        "button",
        { name: "Retry" },
      ),
    );

    expect(mocks.rungs).toEqual([
      expect.objectContaining({
        chatId: TRUNK_ID,
        rung: "retry",
        turnId: FAILED_TURN_ID,
        userMessageId: FAILED_PROMPT_ID,
      }),
    ]);
  });

  it("keeps the bot's own reason with its Retry and Edit when the session's last failed attempt is another turn", async () => {
    failPostOnTrunk();
    nameAttempt(scene.trunk, Date.now() + 3_600_000);
    scene.trunk.setState({
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "prompt-other",
        turnId: "turn-other",
        failure: { reason: "rate_limit" },
        eligibleRungs: ["retry"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "unknown",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    mountChannel(null);

    await within(memberRow()).findByTestId("bot-turn-receipt");

    expect(
      within(memberRow()).getByTestId("bot-message-unanswered").textContent,
    ).toContain(`Not answered: ${BOT_OWN_REASON}`);
    expect(
      within(memberRow()).getByTestId("bot-message-unanswered-retry"),
    ).toBeTruthy();
    expect(
      within(memberRow()).getByTestId("bot-message-unanswered-edit"),
    ).toBeTruthy();
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
  });

  it("keeps the bot's Retry and Edit when the session names no failed attempt", async () => {
    failPostOnTrunk();
    mountChannel(null);

    await within(memberRow()).findByTestId("bot-turn-receipt");

    expect(
      within(memberRow()).getByTestId("bot-message-unanswered-retry"),
    ).toBeTruthy();
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
  });

  it("shows the failed turn's receipt under the line at all times, and it opens the trunk's session landed on the turn", async () => {
    const user = userEvent.setup();
    failPostOnTrunk();
    mountChannel(null);

    const receipt = await within(memberRow()).findByTestId("bot-turn-receipt");

    expect(receipt.textContent).toBe(`${SUMMARY} · ${TOOK}`);
    expect(receipt.className).not.toContain("opacity-0");
    expect(
      within(memberRow())
        .getByTestId("bot-message-unanswered")
        .compareDocumentPosition(receipt) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(receipt);
    expect(openedSessions).toEqual([
      {
        chatId: TRUNK_ID,
        threadId: null,
        messageId: FAILED_PROMPT_ID,
        sendPostId: null,
      },
    ]);
  });
});

describe("a post a thread's session failed to answer", () => {
  it("offers the agent chat's actions in the thread's panel on that session, while the channel's row, whose session is the trunk, keeps the bot's Retry", async () => {
    const user = userEvent.setup();
    failPostOnTrunk();
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedSession(POST_REQUEST) },
      },
    });
    scene.knownTurns = [failedTurn(THREAD_SESSION_ID, THREAD_ID)];
    nameAttempt(scene.threadSession, Date.now() + 3_600_000);
    mountChannel(THREAD_OPEN);

    const pane = screen.getByTestId("bot-thread-pane");
    const actions = await within(pane).findByTestId("failed-turn-actions");

    expect(
      within(memberRow()).getByTestId("bot-message-unanswered-retry"),
    ).toBeTruthy();
    expect(screen.getAllByTestId("failed-turn-actions")).toHaveLength(1);
    await user.click(within(actions).getByRole("button", { name: "Retry" }));
    expect(mocks.rungs).toEqual([
      expect.objectContaining({
        chatId: THREAD_SESSION_ID,
        rung: "retry",
        turnId: FAILED_TURN_ID,
      }),
    ]);
  });
});

describe("the routing card above a bot's box", () => {
  /** A switch counting down to the codex target, as a session's pending fallback. */
  function countdown(): PendingFallback {
    return pendingFallback({
      state: "hold",
      reason: "rate_limit",
      failedTuple: FAILED_CLAUDE_TUPLE,
      targetTuple: TARGET_CODEX_TUPLE,
      impendingAction: null,
      deadline: Date.now() + 30_000,
      attempt: 1,
      maxAttempts: 3,
      queuedItemsMoving: 0,
      siblingSwitching: 0,
      traversalId: "traversal-1",
      revision: 1,
    });
  }

  it("draws the trunk's countdown above the channel's box, and none above the open thread's", async () => {
    scene.trunk.setState({ pendingFallback: countdown() });
    mountChannel(THREAD_OPEN);

    const card = await screen.findByTestId("bot-routing-card");

    expect(screen.getAllByTestId("bot-routing-card")).toHaveLength(1);
    expect(
      within(card).getByRole("button", { name: "Don't switch" }),
    ).toBeTruthy();
    expect(screen.getByTestId("bot-channel").contains(card)).toBe(true);
    expect(
      card.compareDocumentPosition(screen.getByTestId("bot-channel-composer")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws the thread session's countdown above the thread's box, and none above the channel's", async () => {
    scene.threadSession.setState({ pendingFallback: countdown() });
    mountChannel(THREAD_OPEN);

    const card = await screen.findByTestId("bot-routing-card");

    expect(screen.getAllByTestId("bot-routing-card")).toHaveLength(1);
    expect(screen.getByTestId("bot-thread-pane").contains(card)).toBe(true);
    expect(
      card.compareDocumentPosition(screen.getByTestId("bot-thread-composer")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
