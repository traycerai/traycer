/**
 * A bot's Threads tab (Tracy Bots T86): the listed threads, each named by the
 * post it hangs off, and a choice opening that thread beside the channel. The
 * real page runs over a real query result; only the channel's session (the
 * rows the posts are read from) and the host's `chat.locateRow` query, which
 * fetches a post the channel has not loaded, are replaced; the locate-row
 * hook that maps the host's answer runs for real.
 */
import { useEffect, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { chatSessionWithPosts, postRow } from "./bot-channel-rows-test-support";

const mocks = vi.hoisted(() => ({
  openPost: vi.fn<(open: unknown) => void>(),
  /** The channel's posts by message id; none while the channel is not loaded. */
  channelPosts: null as Record<string, string> | null,
  /** The channel's session, built once per case so rows can land in it. */
  channel: null as ChatSessionStoreHandle | null,
  /** Every post the page asked the host to locate, by message id. */
  located: [] as string[],
  /** How the host answers `chat.locateRow`. */
  locateAnswer: "found" as "found" | "not-found" | "rejects",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServingHostId: () => "host-1",
}));
// The host's `chat.locateRow`: asked once per mounted reader that wants the
// row, answered as `locateAnswer` says.
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    params: { target: { kind: string; messageId?: string } };
    cacheKeyIdentity: ReadonlyArray<number>;
    options: { enabled: boolean };
  }) => {
    const { enabled } = args.options;
    const messageId = args.params.target.messageId ?? "";
    useEffect(() => {
      if (enabled) mocks.located.push(messageId);
    }, [enabled, messageId]);
    if (!enabled || mocks.locateAnswer === "rejects") {
      return { data: undefined, isError: enabled };
    }
    return {
      data:
        mocks.locateAnswer === "found"
          ? { found: true, ordinal: 1, epoch: args.cacheKeyIdentity[0] }
          : { found: false },
      isError: false,
    };
  },
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (): ChatSessionStoreHandle | null => {
    if (mocks.channelPosts === null) return null;
    mocks.channel ??= chatSessionWithPosts(mocks.channelPosts);
    return mocks.channel;
  },
}));

import { BotThreadsPage } from "@/components/bots/bot-threads-page";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHANNEL_ID = "conversation-channel";
const POST_ID = conversationRequestMessageId("req-a");

function thread(replyCount: number): BotThreadSummary {
  return withAnchor(replyCount, true);
}

function withAnchor(replyCount: number, anchored: boolean): BotThreadSummary {
  return {
    threadId: "thread-a",
    conversationId: CHANNEL_ID,
    sessionChatId: "session-thread-a",
    anchor: anchored
      ? {
          messageId: POST_ID,
          requestId: "req-a",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
        }
      : null,
    replyCount,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

function Page(props: {
  readonly threads: ReadonlyArray<BotThreadSummary>;
  readonly listed: boolean;
}): ReactNode {
  const list: UseQueryResult<BotThreadListResponse, HostRpcError> = useQuery(
    queryOptions<BotThreadListResponse, HostRpcError>({
      queryKey: ["threads", props.threads],
      queryFn: () =>
        Promise.resolve({
          threads: [...props.threads],
          trunkCostUsd: null,
          threadAnchors: null,
        }),
    }),
  );
  return (
    <BotThreadsPage
      botId={BOT_ID}
      hostId="host-1"
      threadList={props.listed ? list : null}
      onOpenPost={mocks.openPost}
    />
  );
}

function mount(
  threads: ReadonlyArray<BotThreadSummary>,
  listed: boolean,
): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Page threads={threads} listed={listed} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channelPosts = null;
  mocks.channel = null;
  mocks.located = [];
  mocks.locateAnswer = "found";
});

afterEach(() => {
  cleanup();
});

describe("<BotThreadsPage />", () => {
  it("opens a thread, named by its post's first line, with the post it hangs off", async () => {
    const user = userEvent.setup();
    mocks.channelPosts = {
      [POST_ID]: "Please review the release\nIt ships Friday.",
    };
    mount([thread(2)], true);

    const row = await screen.findByRole("button", {
      name: /Please review the release/,
    });
    expect(row.textContent).toContain("2 replies");
    await user.click(row);

    expect(mocks.openPost).toHaveBeenCalledWith({
      anchorMessageId: POST_ID,
      announcement: false,
      answer: false,
      sent: null,
    });
  });

  it("opens an older thread whose post the channel has not loaded: chosen, it fetches the post, shows busy, and opens once the post is read", async () => {
    const user = userEvent.setup();
    // The channel is loaded, but the thread's post is older than its window.
    mocks.channelPosts = {};
    mount([thread(1)], true);

    const row = await screen.findByTestId("bot-thread-row");
    expect(row.textContent).toContain("Thread");
    expect(row.textContent).toContain("1 reply");
    expect(row.hasAttribute("disabled")).toBe(false);
    expect(row.getAttribute("aria-busy")).toBe("false");
    expect(mocks.located).toEqual([]);

    await user.click(row);

    expect(mocks.located).toEqual([POST_ID]);
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(mocks.openPost).not.toHaveBeenCalled();

    // The located row lands in the channel's session.
    act(() => {
      mocks.channel?.store.setState({
        messages: [postRow(POST_ID, "Please review the release")],
      });
    });

    expect(mocks.openPost).toHaveBeenCalledTimes(1);
    expect(mocks.openPost).toHaveBeenCalledWith({
      anchorMessageId: POST_ID,
      announcement: false,
      answer: false,
      sent: null,
    });
    expect(row.textContent).toContain("Please review the release");
    expect(row.getAttribute("aria-busy")).toBe("false");
  });

  it.each(["not-found", "rejects"] as const)(
    "stops being busy and says so, with Retry, when the host's lookup of the post ends without it (%s), and opens nothing",
    async (answer) => {
      const user = userEvent.setup();
      mocks.channelPosts = {};
      mocks.locateAnswer = answer;
      mount([thread(1)], true);

      await user.click(await screen.findByTestId("bot-thread-row"));

      expect(mocks.located).toEqual([POST_ID]);
      const row = screen.getByTestId("bot-thread-row");
      expect(row.getAttribute("aria-busy")).toBe("false");
      expect(row.hasAttribute("disabled")).toBe(true);
      const failure = screen.getByTestId("bot-thread-row-error");
      expect(failure.textContent).toContain("Couldn't load this thread.");
      expect(
        within(failure).getByRole("button", { name: "Retry" }),
      ).toBeTruthy();
      expect(mocks.openPost).not.toHaveBeenCalled();
    },
  );

  it("asks the host again on Retry, and opens the thread once the post is read", async () => {
    const user = userEvent.setup();
    mocks.channelPosts = {};
    mocks.locateAnswer = "not-found";
    mount([thread(1)], true);
    await user.click(await screen.findByTestId("bot-thread-row"));
    expect(mocks.located).toEqual([POST_ID]);

    mocks.locateAnswer = "found";
    await user.click(
      within(screen.getByTestId("bot-thread-row-error")).getByRole("button", {
        name: "Retry",
      }),
    );

    expect(mocks.located).toEqual([POST_ID, POST_ID]);
    expect(screen.queryByTestId("bot-thread-row-error")).toBeNull();
    expect(screen.getByTestId("bot-thread-row").getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(mocks.openPost).not.toHaveBeenCalled();

    act(() => {
      mocks.channel?.store.setState({
        messages: [postRow(POST_ID, "Please review the release")],
      });
    });
    expect(mocks.openPost).toHaveBeenCalledTimes(1);
    expect(mocks.openPost).toHaveBeenCalledWith({
      anchorMessageId: POST_ID,
      announcement: false,
      answer: false,
      sent: null,
    });
  });

  it("leaves a thread with no anchor post unopenable", async () => {
    mocks.channelPosts = {};
    mount([withAnchor(1, false)], true);

    const row = await screen.findByTestId("bot-thread-row");
    expect(row.hasAttribute("disabled")).toBe(true);
  });

  it("says when the bot has no threads, and when its host cannot list them", async () => {
    mount([], true);
    expect(await screen.findByText("No threads yet.")).toBeTruthy();
    cleanup();

    mount([], false);
    expect(
      screen.getByText("This bot's host can't list its threads."),
    ).toBeTruthy();
  });
});
