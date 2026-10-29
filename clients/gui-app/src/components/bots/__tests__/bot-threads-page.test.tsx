/**
 * A bot's Threads tab (Tracy Bots T86): the listed threads, each named by the
 * post it hangs off, and a choice opening that thread beside the channel. The
 * real page runs over a real query result; only the channel's session (the
 * rows the posts are read from) is replaced.
 */
import { type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { chatSessionWithPosts } from "./bot-channel-rows-test-support";

const mocks = vi.hoisted(() => ({
  openPost: vi.fn<(open: unknown) => void>(),
  /** The channel's posts by message id; none while the channel is not loaded. */
  channelPosts: null as Record<string, string> | null,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (): ChatSessionStoreHandle | null =>
    mocks.channelPosts === null
      ? null
      : chatSessionWithPosts(mocks.channelPosts),
}));

import { BotThreadsPage } from "@/components/bots/bot-threads-page";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHANNEL_ID = "conversation-channel";
const POST_ID = conversationRequestMessageId("req-a");

function thread(replyCount: number): BotThreadSummary {
  return {
    threadId: "thread-a",
    conversationId: CHANNEL_ID,
    sessionChatId: "session-thread-a",
    anchor: {
      messageId: POST_ID,
      requestId: "req-a",
      senderUserId: "user-1",
      sentAt: 1_000,
      resolvedAt: null,
    },
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
  const list = useQuery<BotThreadListResponse, HostRpcError>({
    queryKey: ["threads", props.threads],
    queryFn: () =>
      Promise.resolve({
        threads: [...props.threads],
        trunkCostUsd: null,
        threadAnchors: null,
      }),
  });
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

  it("leaves a thread unopenable until the channel has its post", async () => {
    mocks.channelPosts = null;
    mount([thread(1)], true);

    const row = await screen.findByTestId("bot-thread-row");
    expect(row.textContent).toContain("Thread");
    expect(row.textContent).toContain("1 reply");
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
