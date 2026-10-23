/**
 * The bot's under-the-hood view (Tracy Bots, decision 43): what the bot and
 * its environment have cost, the threads it runs, and the transcript of its
 * trunk or of one thread's session. The real panel and the real cost query run
 * over a mocked `host.usage.summary` read per bot; the transcript is a stub
 * that exposes the chat it was handed.
 */
import { useState, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";

interface UsageAnswer {
  readonly totalUsd: number;
  readonly buckets: ReadonlyArray<{ chatId: string; knownCostUsd: number }>;
}

const mocks = vi.hoisted(() => {
  const answers: Record<string, UsageAnswer> = {};
  return {
    client: { stub: "tab-host-client" },
    refetchThreads: vi.fn<() => void>(),
    state: {
      usageSupported: true,
      answers,
      threads: [] as BotThreadSummary[],
      threadListSupported: true,
      // `false`: the thread list has not answered (pending, or failed).
      threadListAnswered: true,
      threadListError: false,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: vi.fn(),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.state.threadListSupported,
}));
vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: () => mocks.state.usageSupported,
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: mocks.state.threadListAnswered
      ? { threads: mocks.state.threads }
      : undefined,
    isError: mocks.state.threadListError,
    refetch: mocks.refetchThreads,
  }),
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({ tasksById: new Map() }),
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{ params: { epicId: string | null } }>;
  }) =>
    args.requests.map((request) => {
      const epicId = request.params.epicId;
      const answer =
        epicId === null || !Object.hasOwn(mocks.state.answers, epicId)
          ? null
          : mocks.state.answers[epicId];
      return {
        data:
          answer === null
            ? undefined
            : {
                summary: {
                  totals: { knownCostUsd: answer.totalUsd },
                  chatBuckets: answer.buckets,
                },
              },
      };
    }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
}));
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: { chatId: string }) => (
    <div data-testid="stub-transcript" data-chat-id={props.chatId} />
  ),
}));

import { BotUnderTheHoodPanel } from "@/components/bots/bot-under-the-hood-panel";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SIBLING_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TRUNK_ID = "trunk-1";

function answer(
  totalUsd: number,
  buckets: ReadonlyArray<{ chatId: string; knownCostUsd: number }>,
): UsageAnswer {
  return { totalUsd, buckets: [...buckets] };
}

function thread(
  threadId: string,
  text: string,
  overrides: Partial<BotThreadSummary>,
): BotThreadSummary {
  return {
    threadId,
    conversationId: "conversation-channel",
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: `post-${threadId}`,
      requestId: `req-${threadId}`,
      senderUserId: "user-1",
      text,
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 2,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
    ...overrides,
  };
}

function Panel(props: {
  readonly onSelectSession: (sessionChatId: string | null) => void;
  readonly sessionChatId: string | null;
}): ReactNode {
  return (
    <BotUnderTheHoodPanel
      botId={BOT_ID}
      hostId="host-bound"
      botTitle="Release Bot"
      trunkChatId={TRUNK_ID}
      tasks={[]}
      openRequestCount={null}
      paused={false}
      environmentLabel="Acme"
      environmentBotIds={[BOT_ID, SIBLING_ID]}
      sessionChatId={props.sessionChatId}
      onSelectSession={props.onSelectSession}
    />
  );
}

function StatefulPanel(): ReactNode {
  const [sessionChatId, setSessionChatId] = useState<string | null>(null);
  return (
    <Panel sessionChatId={sessionChatId} onSelectSession={setSessionChatId} />
  );
}

function cost(testId: string): string {
  return within(screen.getByTestId("bot-costs")).getByTestId(testId)
    .textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.usageSupported = true;
  mocks.state.answers = {};
  mocks.state.threads = [];
  mocks.state.threadListSupported = true;
  mocks.state.threadListAnswered = true;
  mocks.state.threadListError = false;
});

afterEach(() => {
  cleanup();
});

describe("<BotUnderTheHoodPanel /> cost", () => {
  it("shows the bot's total, its trunk's share, and the sum across its environment's bots", () => {
    mocks.state.answers = {
      [BOT_ID]: answer(12.5, [
        { chatId: "session-thread-a", knownCostUsd: 9.25 },
        { chatId: TRUNK_ID, knownCostUsd: 3.25 },
      ]),
      [SIBLING_ID]: answer(7.5, [{ chatId: "other-trunk", knownCostUsd: 7.5 }]),
    };
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    expect(cost("bot-cost-bot")).toBe("$12.50");
    expect(cost("bot-cost-trunk")).toBe("$3.25");
    expect(cost("bot-cost-environment")).toBe("$20.00");
    expect(
      within(screen.getByTestId("bot-costs")).getByText("Acme"),
    ).toBeTruthy();
  });

  it("shows a trunk with no turns as $0.00", () => {
    mocks.state.answers = {
      [BOT_ID]: answer(4, [{ chatId: "session-thread-a", knownCostUsd: 4 }]),
      [SIBLING_ID]: answer(1, []),
    };
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    expect(cost("bot-cost-bot")).toBe("$4.00");
    expect(cost("bot-cost-trunk")).toBe("$0.00");
  });

  it("shows the environment's figure as unknown while one of its bots has not answered, and the bot's own regardless", () => {
    mocks.state.answers = {
      [BOT_ID]: answer(12.5, [{ chatId: TRUNK_ID, knownCostUsd: 3.25 }]),
    };
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    expect(cost("bot-cost-bot")).toBe("$12.50");
    expect(cost("bot-cost-trunk")).toBe("$3.25");
    expect(cost("bot-cost-environment")).toBe("—");
  });

  it("shows no cost section on a host that cannot report usage", () => {
    mocks.state.usageSupported = false;
    mocks.state.answers = { [BOT_ID]: answer(12.5, []) };
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    expect(screen.queryByTestId("bot-costs")).toBeNull();
    expect(screen.getByTestId("bot-threads")).toBeTruthy();
  });
});

describe("<BotUnderTheHoodPanel /> sessions", () => {
  it("shows a thread's session transcript when its row is chosen, and the trunk again from Show trunk", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      thread("thread-a", "Please review the release", { costUsd: 1.5 }),
      thread("thread-b", "Roll back the deploy", {}),
    ];
    render(<StatefulPanel />);

    const transcript = (): string | null =>
      screen.getByTestId("stub-transcript").getAttribute("data-chat-id");
    expect(transcript()).toBe(TRUNK_ID);
    expect(screen.getByTestId("bot-session-heading").textContent).toBe("Trunk");
    expect(screen.queryByRole("button", { name: "Show trunk" })).toBeNull();

    await user.click(screen.getAllByTestId("bot-thread-row")[1]);

    expect(transcript()).toBe("session-thread-b");
    expect(screen.getByTestId("bot-session-heading").textContent).toBe(
      "Thread: Roll back the deploy",
    );

    await user.click(screen.getByRole("button", { name: "Show trunk" }));

    expect(transcript()).toBe(TRUNK_ID);
    expect(screen.getByTestId("bot-session-heading").textContent).toBe("Trunk");
  });

  it("lists each thread by the post it answers, with its replies and its cost when known", () => {
    mocks.state.threads = [
      thread("thread-a", "Please review the release", {
        replyCount: 1,
        costUsd: 1.5,
      }),
      thread("thread-b", "Roll back the deploy", { replyCount: 4 }),
    ];
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    const [first, second] = screen.getAllByTestId("bot-thread-row");
    expect(within(first).getByText("Please review the release")).toBeTruthy();
    expect(within(first).getByText("1 reply")).toBeTruthy();
    expect(within(first).getByTestId("bot-thread-row-cost").textContent).toBe(
      "$1.50",
    );
    expect(within(second).getByText("4 replies")).toBeTruthy();
    expect(within(second).queryByTestId("bot-thread-row-cost")).toBeNull();
  });
});

describe("<BotUnderTheHoodPanel /> thread list unavailable", () => {
  it("lists no threads on a host without the thread list", () => {
    mocks.state.threadListSupported = false;
    mocks.state.threadListAnswered = false;
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    expect(screen.queryByTestId("bot-threads")).toBeNull();
  });

  it("says the thread list failed, not that there are no threads, and reads it again on Retry", async () => {
    const user = userEvent.setup();
    mocks.state.threadListAnswered = false;
    mocks.state.threadListError = true;
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    const threads = screen.getByTestId("bot-threads");
    expect(within(threads).queryByText("No threads yet.")).toBeNull();
    const failure = within(threads).getByTestId("bot-threads-error");
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);
  });

  it("waits for the thread list before saying there are none", () => {
    mocks.state.threadListAnswered = false;
    render(<Panel sessionChatId={null} onSelectSession={vi.fn()} />);

    const threads = screen.getByTestId("bot-threads");
    expect(within(threads).getByTestId("bot-threads-loading")).toBeTruthy();
    expect(within(threads).queryByText("No threads yet.")).toBeNull();
  });
});
