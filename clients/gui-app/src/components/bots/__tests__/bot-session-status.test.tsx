/**
 * T179: the read-only bot session's status surfaces - the real context usage
 * chip and the real background items listing, mounted the way the tab
 * actually mounts them (`BotSessionStatusDataContext` around the real
 * `BotSessionView`, which hands the viewed session's transcript handle to
 * `BotSessionStatus` via `BotSessionStatusSlotContext`). Only the session
 * registry, the host reads the transcript makes beside its rows, and
 * navigation are replaced - the chip, the listing, the row simplification
 * and the trunk/thread filtering are the real production code.
 */
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type {
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  botNotificationSubscriptionSchema,
  botTaskEntrySchema,
} from "@traycer/protocol/host/bot/schemas";
import { installManagedCommandChatSession } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: mocks.navigateToTabIntent,
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
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
  useGuiHarnessesQueryForClient: () => ({ data: undefined, isPending: false }),
}));
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
// The one faked boundary the background listing needs beyond the session
// registry: the host RPCs behind the managed-command rows (same fake
// `chat-background-items-panel.test.tsx` uses - this suite is about the
// bot session's status surfaces, not managed-command lifecycle RPCs).
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

import { BotSessionView } from "@/components/bots/bot-session-view";
import { BotSessionStatusDataContext } from "@/components/bots/bot-session-status-context";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  scriptedSession,
  sessionPrompt,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const TRUNK_ID = "trunk-chat";
const THREAD_ID = "thread-1";
const THREAD_SESSION_ID = "session-1";

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

const USAGE: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

const opened = {
  channel: vi.fn<(messageId: string | null) => void>(),
  thread: vi.fn<(threadId: string, messageId: string | null) => void>(),
  close: vi.fn<() => void>(),
};

/** A viewed session's own store, made "fresh" (as `BackgroundItemsPanel`
 *  reads it) and carrying `usage` for the chip. */
function freshSession(
  chatId: string,
  usage: TokenUsage | null,
): ChatSessionStoreHandle {
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
  ]);
  handle.store.setState({
    transcriptBaselineEpoch: 0,
    connectionEpoch: 0,
    liveTurnUsage: usage,
  });
  return handle;
}

/** The same session, but reconnected mid-resync: the connection moved to a
 *  new epoch its transcript baseline has not caught up to yet - the fact
 *  `fresh` reads to call a session stale, independent of `connectionStatus`
 *  or `snapshotLoaded`. */
function staleReconnectingSession(
  chatId: string,
  usage: TokenUsage | null,
): ChatSessionStoreHandle {
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
  ]);
  handle.store.setState({
    transcriptBaselineEpoch: 0,
    connectionEpoch: 1,
    liveTurnUsage: usage,
  });
  return handle;
}

function task(taskId: string, overrides: Partial<BotTaskEntry>): BotTaskEntry {
  return botTaskEntrySchema.parse({
    taskId,
    cadence: { kind: "none" },
    lastCheckinAt: 1_000,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: null,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    checkins: null,
    pause: null,
    stop: null,
    runRequest: null,
    ...overrides,
  });
}

function subscription(
  overrides: Partial<BotNotificationSubscription>,
): BotNotificationSubscription {
  return botNotificationSubscriptionSchema.parse({
    target: { kind: "trunk" },
    attentionOnly: false,
    everySeconds: 7_200,
    since: null,
    digests: null,
    ...overrides,
  });
}

function mountSession(input: {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly subscriptions: ReadonlyArray<BotNotificationSubscription> | null;
  readonly resolveMember?: BotMemberResolver;
}): void {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotIdentityContext value={IDENTITY}>
            <BotSessionStatusDataContext
              value={{ tasks: input.tasks, subscriptions: input.subscriptions }}
            >
              <BotSessionView
                botId={BOT_ID}
                hostId={HOST_ID}
                botTitle="Release Bot"
                session={{
                  chatId: input.chatId,
                  threadId: input.threadId,
                  landOn: null,
                }}
                threads={[]}
                resolveMember={input.resolveMember ?? UNRESOLVED_BOT_MEMBERS}
                onClose={opened.close}
                onOpenChannel={opened.channel}
                onOpenThread={opened.thread}
              />
            </BotSessionStatusDataContext>
          </BotIdentityContext>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

/** Opens the background listing's own collapsible, closed by default. */
function openBackground(): void {
  fireEvent.click(within(view()).getByRole("button", { name: /Background/ }));
}

beforeEach(() => {
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  mocks.sessions = {};
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
});

describe("the trunk session's status surfaces", () => {
  beforeEach(() => {
    mocks.sessions[TRUNK_ID] = freshSession(TRUNK_ID, USAGE);
  });

  it("shows the real context chip's usage, with no compact action and no pin-breakdown control", async () => {
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [],
      subscriptions: null,
    });
    await settleLegendList();

    const trigger = within(view()).getByRole("button", {
      name: /Context window/,
    });
    expect(
      within(view()).queryByTestId("context-usage-compact-action"),
    ).toBeNull();

    fireEvent.click(trigger);

    // The breakdown popover portals to `document.body`, outside the session
    // view's own subtree.
    expect(screen.getByText("Context window")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin breakdown" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Unpin breakdown" }),
    ).toBeNull();
  });

  it("hides the context chip entirely while the session is stale (reconnected, transcript not yet resynced), even though usage data is present", async () => {
    mocks.sessions[TRUNK_ID] = staleReconnectingSession(TRUNK_ID, USAGE);
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [],
      subscriptions: null,
    });
    await settleLegendList();

    // Not the ghost placeholder either: a read-only session draws no editor
    // and so no ghost affordance, only the chip itself or nothing.
    expect(within(view()).queryByTestId("context-usage-chip")).toBeNull();
    expect(within(view()).queryByTestId("context-usage-chip-ghost")).toBeNull();
  });

  it("lists a periodic task's check-ins and a trunk-targeted subscription, each with no stop or pin control", async () => {
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [
        task("task-periodic", {
          cadence: { kind: "every", seconds: 3_600 },
          label: "Nightly audit",
        }),
      ],
      subscriptions: [subscription({ target: { kind: "trunk" } })],
    });
    await settleLegendList();
    openBackground();

    const taskButton = within(view()).getByRole("button", {
      name: /Nightly audit · Check-ins/,
    });
    expect(taskButton).toBeTruthy();
    const taskRow = taskButton.closest("li");
    if (taskRow === null) throw new Error("task row not found");
    // The task row's own navigate-to-task link is its only control: no Stop,
    // no Pin, nothing that would act on the check-in task from here.
    expect(within(taskRow).getAllByRole("button")).toEqual([taskButton]);

    const subscriptionText = within(view()).getByText(
      /Notifications · Every 2 hours/,
    );
    expect(subscriptionText).toBeTruthy();
    const subscriptionRow = subscriptionText.closest("li");
    if (subscriptionRow === null) throw new Error("subscription row not found");
    // Pure display: a notification row offers no control at all.
    expect(within(subscriptionRow).queryAllByRole("button")).toEqual([]);
  });

  describe("the collapsed header's summary", () => {
    it("says '0 running' with no item suffix when there are no tasks or subscriptions", async () => {
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        tasks: [],
        subscriptions: [],
      });
      await settleLegendList();

      expect(
        within(view()).getByTestId("background-header-summary").textContent,
      ).toBe("0 running");
    });

    it("counts a periodic task and a trunk subscription as ' · 2 items', alongside the running summary", async () => {
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        tasks: [
          task("task-periodic", {
            cadence: { kind: "every", seconds: 3_600 },
            label: "Nightly audit",
          }),
        ],
        subscriptions: [subscription({ target: { kind: "trunk" } })],
      });
      await settleLegendList();

      expect(
        within(view()).getByTestId("background-header-summary").textContent,
      ).toBe("0 running · 2 items");
    });

    it("does not count the 'Subscriptions unavailable' placeholder as an item", async () => {
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        tasks: [],
        subscriptions: null,
      });
      await settleLegendList();

      expect(
        within(view()).getByTestId("background-header-summary").textContent,
      ).toBe("0 running");
      openBackground();
      expect(
        within(view()).getByText("Subscriptions unavailable"),
      ).toBeTruthy();
    });
  });

  it("does not list a thread's own one-off task or a thread-targeted subscription", async () => {
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [
        task("task-thread-owned", {
          cadence: { kind: "none" },
          createdByChatId: THREAD_ID,
          checkins: [],
          lastCheckinAt: 2_000,
          label: "One-off from thread",
        }),
      ],
      subscriptions: [
        subscription({ target: { kind: "thread", threadId: THREAD_ID } }),
      ],
    });
    await settleLegendList();
    openBackground();

    expect(within(view()).queryByText(/One-off from thread/)).toBeNull();
    expect(within(view()).queryByText(/Notifications ·/)).toBeNull();
  });

  it("shows a subscription's attention-only flag and since timestamp, carried alongside its frequency", async () => {
    const since = Date.UTC(2026, 0, 5, 9, 30);
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [],
      subscriptions: [
        subscription({
          target: { kind: "trunk" },
          attentionOnly: true,
          since,
        }),
      ],
    });
    await settleLegendList();
    openBackground();

    const row = within(view()).getByText(/Notifications ·/);
    expect(row.textContent).toContain("Every 2 hours");
    expect(row.textContent).toContain("Attention only");
    expect(row.textContent).toContain("Since");
  });

  it("says 'Subscriptions unavailable' when none were read yet (null), never when the read finished with none ([])", async () => {
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [],
      subscriptions: null,
    });
    await settleLegendList();
    openBackground();
    expect(within(view()).getByText("Subscriptions unavailable")).toBeTruthy();
    expect(within(view()).queryByText(/Notifications ·/)).toBeNull();
    cleanup();

    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [],
      subscriptions: [],
    });
    await settleLegendList();
    openBackground();
    expect(within(view()).queryByText("Subscriptions unavailable")).toBeNull();
    expect(within(view()).queryByText(/Notifications ·/)).toBeNull();
  });

  it("opens the named task, not the Activity tab, from the check-in row", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mountSession({
      chatId: TRUNK_ID,
      threadId: null,
      tasks: [
        task("task-periodic", { cadence: { kind: "every", seconds: 3_600 } }),
      ],
      subscriptions: null,
    });
    await settleLegendList();
    openBackground();

    await user.click(within(view()).getByRole("button", { name: /Check-ins/ }));

    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent.mock.calls[0]?.[1]).toMatchObject({
      kind: "open-epic",
      epicId: "task-periodic",
    });
  });

  it("simplifies a running shell row to a plain status line with no Stop control", async () => {
    const command = managedCommandSchema.parse({
      id: "shell-deploy",
      monitoring: true,
      description: "deploy watcher",
      command: "tail -f deploy.log",
      cwd: "/work/repo",
      cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
      status: { state: "running", pid: 42, startedAtMs: 2_000 },
      chatId: TRUNK_ID,
      relaunchOnHostRestart: false,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    const session = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: TRUNK_ID,
      hostId: HOST_ID,
    });
    try {
      session.setCommands([command]);
      session.setConnectionStatus("open");
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        tasks: [],
        subscriptions: null,
      });
      await settleLegendList();
      openBackground();

      const row = within(view()).getByTestId(
        "managed-command-background-row-shell-deploy",
      );
      expect(within(row).getByText(/deploy watcher/)).toBeTruthy();
      expect(within(row).queryByRole("button")).toBeNull();
      expect(
        within(view()).queryByRole("button", { name: /stop/i }),
      ).toBeNull();
    } finally {
      cleanup();
      session.dispose();
    }
  });

  it("drops the shell row to 'Status unavailable' on reconnect, but keeps the check-in and subscription rows, which do not depend on the stream", async () => {
    const command = managedCommandSchema.parse({
      id: "shell-watch",
      monitoring: true,
      description: "watch deploy",
      command: "tail -f deploy.log",
      cwd: "/work/repo",
      cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
      status: { state: "running", pid: 42, startedAtMs: 2_000 },
      chatId: TRUNK_ID,
      relaunchOnHostRestart: false,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    const session = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: TRUNK_ID,
      hostId: HOST_ID,
    });
    try {
      session.setCommands([command]);
      session.setConnectionStatus("open");
      mountSession({
        chatId: TRUNK_ID,
        threadId: null,
        tasks: [
          task("task-periodic", { cadence: { kind: "every", seconds: 7_200 } }),
        ],
        subscriptions: [subscription({ target: { kind: "trunk" } })],
      });
      await settleLegendList();
      openBackground();

      expect(
        within(view()).getByTestId(
          "managed-command-background-row-shell-watch",
        ),
      ).toBeTruthy();
      expect(
        within(view()).getByRole("button", { name: /Check-ins/ }),
      ).toBeTruthy();
      expect(within(view()).getByText(/Notifications ·/)).toBeTruthy();
      expect(within(view()).queryAllByText("Status unavailable")).toHaveLength(
        0,
      );

      act(() => {
        mocks.sessions[TRUNK_ID].store.setState({
          connectionStatus: "reconnecting",
          // A real reconnect bumps the epoch; the fresh snapshot that
          // follows is what later moves `transcriptBaselineEpoch` to match.
          connectionEpoch: 1,
        });
      });

      expect(
        within(view()).queryByTestId(
          "managed-command-background-row-shell-watch",
        ),
      ).toBeNull();
      expect(
        within(view()).getAllByText("Status unavailable").length,
      ).toBeGreaterThan(0);
      expect(
        within(view()).getByRole("button", { name: /Check-ins/ }),
      ).toBeTruthy();
      expect(within(view()).getByText(/Notifications ·/)).toBeTruthy();

      // The socket is back, but no snapshot has landed on the new epoch yet:
      // `transcriptBaselineEpoch` still names the old one, so this must read
      // exactly as unavailable as mid-reconnect - not "open" alone.
      act(() => {
        mocks.sessions[TRUNK_ID].store.setState({ connectionStatus: "open" });
      });

      expect(
        within(view()).queryByTestId(
          "managed-command-background-row-shell-watch",
        ),
      ).toBeNull();
      expect(
        within(view()).getAllByText("Status unavailable").length,
      ).toBeGreaterThan(0);

      // The real snapshot: baseline catches up to the new epoch.
      act(() => {
        mocks.sessions[TRUNK_ID].store.setState({
          snapshotLoaded: true,
          transcriptBaselineEpoch: 1,
        });
      });

      expect(
        within(view()).getByTestId(
          "managed-command-background-row-shell-watch",
        ),
      ).toBeTruthy();
      expect(within(view()).queryAllByText("Status unavailable")).toHaveLength(
        0,
      );
    } finally {
      cleanup();
      session.dispose();
    }
  });
});

describe("a thread session's status surfaces", () => {
  beforeEach(() => {
    mocks.sessions[THREAD_SESSION_ID] = freshSession(THREAD_SESSION_ID, null);
  });

  it("lists the one-off task it created, not the trunk's periodic task or a trunk-targeted subscription", async () => {
    mountSession({
      chatId: THREAD_SESSION_ID,
      threadId: THREAD_ID,
      tasks: [
        task("task-thread-owned", {
          cadence: { kind: "none" },
          createdByChatId: THREAD_ID,
          checkins: [],
          lastCheckinAt: 2_000,
          label: "One-off from thread",
        }),
        task("task-periodic", { cadence: { kind: "every", seconds: 3_600 } }),
      ],
      subscriptions: [
        subscription({ target: { kind: "thread", threadId: THREAD_ID } }),
        subscription({ target: { kind: "trunk" } }),
      ],
    });
    await settleLegendList();
    openBackground();

    expect(
      within(view()).getByRole("button", {
        name: /One-off from thread · Check-ins/,
      }),
    ).toBeTruthy();
    expect(
      within(view()).queryByText(/Nightly audit|task-periodic/),
    ).toBeNull();
    expect(within(view()).getAllByText(/Notifications ·/)).toHaveLength(1);
  });
});
