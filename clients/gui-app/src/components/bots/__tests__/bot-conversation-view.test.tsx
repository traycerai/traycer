/**
 * A bot's conversation view (Tracy Bots): the transcript when the bot can be
 * served to this tab, a placeholder that names no machine while it is paused,
 * and a composer that writes through `bot.conversation.send` either way - the
 * host answers `queued` when the bot's host is away, and the view says so
 * once.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConversationSendDelivery } from "@traycer/protocol/host/bot/conversation-schemas";

const mocks = vi.hoisted(() => {
  const initialDelivery = (): BotConversationSendDelivery => "written";
  return {
    hostClient: { stub: "tab-host-client" },
    send: vi.fn<
      (variables: {
        botId: string;
        conversationId: string;
        text: string;
      }) => void
    >(),
    state: {
      // `null` is an unanswered list (the query has no data yet); `[]` is an
      // answered, empty one - the two states the view tells apart.
      conversations: [] as Array<{
        conversationId: string;
        createdAt: number;
      }> | null,
      isError: false,
      delivery: initialDelivery(),
    },
  };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data:
      mocks.state.conversations === null
        ? undefined
        : { conversations: mocks.state.conversations },
    isError: mocks.state.isError,
    refetch: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    isPending: false,
    error: null,
    mutate: (
      variables: { botId: string; conversationId: string; text: string },
      options: {
        onSuccess: (response: {
          messageId: string;
          requestId: string;
          delivery: BotConversationSendDelivery;
        }) => void;
      },
    ) => {
      mocks.send(variables);
      options.onSuccess({
        messageId: "message-1",
        requestId: "request-1",
        delivery: mocks.state.delivery,
      });
    },
  }),
}));
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: { chatId: string; hostId: string }) => (
    <div
      data-testid="stub-transcript"
      data-chat-id={props.chatId}
      data-host-id={props.hostId}
    />
  ),
}));

import { BotConversationView } from "@/components/bots/bot-conversation-view";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function mountView(paused: boolean): void {
  render(
    <StrictMode>
      <BotConversationView
        botId={BOT_ID}
        hostId="host-tab"
        botTitle="Release Bot"
        paused={paused}
      />
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.conversations = [
    { conversationId: "conversation-later", createdAt: 2_000 },
    { conversationId: "conversation-app", createdAt: 1_000 },
  ];
  mocks.state.isError = false;
  mocks.state.delivery = "written";
});

afterEach(() => {
  cleanup();
});

describe("<BotConversationView /> transcript", () => {
  it("renders the transcript of the app conversation (the earliest) when the bot is not paused", () => {
    mountView(false);

    const transcript = screen.getByTestId("stub-transcript");
    expect(transcript.getAttribute("data-chat-id")).toBe("conversation-app");
    expect(transcript.getAttribute("data-host-id")).toBe("host-tab");
    expect(screen.queryByTestId("bot-transcript-paused")).toBeNull();
  });

  it("stands a placeholder that names no machine in for the transcript while the bot is paused", () => {
    mountView(true);

    const placeholder = screen.getByTestId("bot-transcript-paused");
    expect(placeholder.textContent).toContain(
      "shows here once the bot can be reached",
    );
    expect(placeholder.textContent).not.toMatch(/host|Studio Mac|offline/i);
    expect(screen.queryByTestId("stub-transcript")).toBeNull();
    expect(screen.getByTestId("bot-conversation-composer")).toBeTruthy();
  });
});

describe("<BotConversationView /> composer", () => {
  it("still sends through bot.conversation.send while the bot is paused", async () => {
    const user = userEvent.setup();
    mountView(true);

    await user.type(
      screen.getByTestId("bot-conversation-input"),
      "Please check the release",
    );
    await user.click(screen.getByTestId("bot-conversation-send"));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      botId: BOT_ID,
      conversationId: "conversation-app",
      text: "Please check the release",
    });
    const input = screen.getByTestId("bot-conversation-input");
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error("the composer input is a textarea");
    }
    expect(input.value).toBe("");
  });

  it("says the message was saved when the host answers queued", async () => {
    const user = userEvent.setup();
    mocks.state.delivery = "queued";
    mountView(true);
    expect(screen.queryByTestId("bot-conversation-queued")).toBeNull();

    await user.type(screen.getByTestId("bot-conversation-input"), "Hello");
    await user.click(screen.getByTestId("bot-conversation-send"));

    const queued = screen.getByTestId("bot-conversation-queued");
    expect(queued.textContent).toBe(
      "Saved. The bot reads it once it can be reached.",
    );
    expect(queued.textContent).not.toMatch(/host|offline/i);
  });

  it("shows no queued line when the host wrote the message in line", async () => {
    const user = userEvent.setup();
    mocks.state.delivery = "written";
    mountView(false);

    await user.type(screen.getByTestId("bot-conversation-input"), "Hello");
    await user.click(screen.getByTestId("bot-conversation-send"));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("bot-conversation-queued")).toBeNull();
  });

  it("clears the queued line once the person starts another message", async () => {
    const user = userEvent.setup();
    mocks.state.delivery = "queued";
    mountView(true);

    await user.type(screen.getByTestId("bot-conversation-input"), "One");
    await user.click(screen.getByTestId("bot-conversation-send"));
    expect(screen.getByTestId("bot-conversation-queued")).toBeTruthy();

    await user.type(screen.getByTestId("bot-conversation-input"), "T");
    expect(screen.queryByTestId("bot-conversation-queued")).toBeNull();
  });
});

describe("<BotConversationView /> states", () => {
  it("shows the loading state while the conversation list has not answered", () => {
    mocks.state.conversations = null;
    mountView(false);

    expect(screen.getByTestId("bot-conversation-loading")).toBeTruthy();
    expect(screen.queryByTestId("bot-conversation-empty")).toBeNull();
    expect(screen.queryByTestId("bot-conversation-composer")).toBeNull();
  });

  it("tells an answered, empty list apart from a pending one", () => {
    mocks.state.conversations = [];
    mountView(false);

    expect(screen.getByTestId("bot-conversation-empty")).toBeTruthy();
    expect(screen.queryByTestId("bot-conversation-loading")).toBeNull();
    expect(screen.queryByTestId("bot-conversation-composer")).toBeNull();
  });

  it("shows a retryable error when the conversation list fails", () => {
    mocks.state.isError = true;
    mountView(false);

    expect(screen.getByTestId("bot-conversation-error")).toBeTruthy();
    expect(screen.queryByTestId("bot-conversation-composer")).toBeNull();
  });
});
