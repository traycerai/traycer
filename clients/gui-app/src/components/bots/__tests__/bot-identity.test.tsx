/**
 * A bot looks like a bot (Tracy Bots, T62): on a bot's channel rows the
 * bot's picture is a squircle and a person's a circle, read from the
 * rendered element's clip; the bot's name carries "managed by" its owner,
 * whose name opens the owner's card; and the bot's card says what it is
 * doing now from the real `useBotActivity` over the real shared
 * `bot.subscribe` subscription, whose stream the test scripts.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  BotActivity,
  BotSessionActivity,
  BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentMember } from "@traycer/protocol/host/environment/contracts";
import { avatarShape } from "@/components/bots/__tests__/avatar-shape";
import {
  BotIdentityContext,
  type BotIdentity,
  type BotOwner,
} from "@/components/bots/bot-identity-context";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatMessage } from "@/components/chat/chat-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import { __resetBotSubscriptionsForTesting } from "@/hooks/bots/use-bot-subscription";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";

const stream = vi.hoisted(() => ({
  client: null as StubHostStreamClient | null,
}));

// The host's stream client is the stub's; the subscription is the real one.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/bots/use-bot-subscription")>();
  return {
    ...actual,
    useBotSubscriptionForHost: (args: {
      readonly hostId: string;
      readonly botId: string;
      readonly enabled: boolean;
    }) =>
      actual.useBotSubscriptionForClient({
        ...args,
        client: stream.client,
      }),
  };
});

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-1";
const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

const PRESENTATION: ChatBotPresentation = {
  botTitle: "Tracy",
  scrollToMessage: null,
  replyFollowsPost: null,
  repliedPost: null,
  threadLine: null,
  openThread: null,
  openAnnouncementThread: null,
  chooseOption: null,
  failedRequest: null,
};

const PERSON: BotOwner = {
  kind: "person",
  userId: "user-owner",
  name: "Olive Owner",
  avatarUrl: null,
};

function member(index: number): EnvironmentMember {
  return {
    userId: `user-${String(index)}`,
    displayName: `Member ${String(index)}`,
    avatarUrl: null,
  };
}

const TEAM: BotOwner = {
  kind: "team",
  name: "Acme",
  members: [1, 2, 3, 4, 5, 6].map(member),
};

function replying(step: string | null): BotSessionActivity {
  return {
    state: "replying",
    startedAt: Date.now() - 83_500,
    step,
    requestId: "req-1",
    reason: null,
  };
}

function snapshot(activity: BotActivity): BotSubscribeServerFrame {
  return {
    kind: "snapshot",
    bot: {
      botId: BOT_ID,
      environmentId: "env-1",
      createdByUserId: "user-owner",
      title: "Tracy",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: HOST_ID,
      hostEpoch: 0,
      createdAt: 1,
      archivedAt: null,
      directive: null,
      replyMode: "direct",
      appConversationChatId: null,
    },
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: 0,
    boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
    activity,
    hasBinaryPayload: false,
  };
}

function botReply(): ChatMessageModel {
  return {
    ...makeMessage(1, "assistant"),
    segments: [
      {
        id: "message-1:text",
        kind: "text",
        markdown: "Done.",
        isStreaming: false,
      },
    ],
  };
}

function memberPost(): ChatMessageModel {
  return {
    ...makeMessage(0, "user"),
    persistentMessageId: "post-1",
    senderLabel: "Tess Teammate",
  };
}

function mount(
  messages: ReadonlyArray<ChatMessageModel>,
  owner: BotOwner | null,
): {
  readonly session: StubSession;
  readonly openActivity: Mock<() => void>;
} {
  const session = new StubSession();
  stream.client = new StubHostStreamClient(session);
  const openActivity = vi.fn<() => void>();
  const identity: BotIdentity = {
    botId: BOT_ID,
    title: "Tracy",
    owner,
    openActivity,
  };
  function Providers(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotIdentityContext value={identity}>
              <ChatBotPresentationContext.Provider value={PRESENTATION}>
                {props.children}
              </ChatBotPresentationContext.Provider>
            </BotIdentityContext>
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }
  render(
    <>
      {messages.map((message) => (
        <ChatMessage
          key={message.id}
          message={message}
          actions={null}
          backgroundToolBlockIds={EMPTY_BACKGROUND_TOOL_BLOCK_IDS}
          nextStepActions={null}
        />
      ))}
    </>,
    { wrapper: Providers },
  );
  return { session, openActivity };
}

beforeEach(() => {
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: HOST_ID, title: "Tracy" });
});

afterEach(() => {
  cleanup();
  __resetBotSubscriptionsForTesting();
  useBotTabsStore.setState({ tabs: {} });
  stream.client = null;
});

describe("a bot channel's rows", () => {
  it("draw the bot as a squircle and a person as a circle", () => {
    mount([memberPost(), botReply()], PERSON);

    const botRow = screen.getByTestId("bot-reply-row");
    const memberRow = screen.getByTestId("bot-member-row");
    expect(avatarShape(within(botRow).getByTestId("bot-avatar"))).toBe(
      "squircle",
    );
    expect(
      avatarShape(within(memberRow).getByTestId("chat-sender-avatar")),
    ).toBe("circle");
    // Without a picture, the initials stand in.
    expect(within(botRow).getByTestId("bot-avatar").textContent).toBe("TR");
  });
});

describe("the owner line beside a bot's name", () => {
  it("names a person owner, whose name opens their card", async () => {
    const user = userEvent.setup();
    mount([botReply()], PERSON);

    const line = screen.getByTestId("bot-owner-line");
    expect(line.textContent).toBe("·managed byOlive Owner");
    await user.click(within(line).getByTestId("bot-owner-name"));

    const card = await screen.findByTestId("bot-owner-card");
    expect(card.textContent).toContain("Olive Owner");
    expect(card.textContent).toContain("Owns this bot");
    expect(avatarShape(within(card).getByTestId("chat-sender-avatar"))).toBe(
      "circle",
    );
  });

  it("names a team owner, whose card stacks its members with +N for the rest", async () => {
    const user = userEvent.setup();
    mount([botReply()], TEAM);

    await user.click(screen.getByTestId("bot-owner-name"));

    const card = await screen.findByTestId("bot-owner-card");
    expect(card.textContent).toContain("Acme");
    expect(card.textContent).toContain("6 members");
    const stack = within(card).getByTestId("bot-owner-members");
    expect(within(stack).getAllByTestId("chat-sender-avatar")).toHaveLength(4);
    expect(
      within(stack).getByTestId("bot-owner-members-more").textContent,
    ).toBe("+2");
  });

  it("is absent until the bot's owner is known", () => {
    mount([botReply()], null);

    expect(screen.queryByTestId("bot-owner-line")).toBeNull();
  });
});

describe("the bot's card", () => {
  it("shows what the bot is doing while its turn runs, and clears when it ends", async () => {
    const user = userEvent.setup();
    const tab = mount([botReply()], PERSON);
    await user.click(screen.getByTestId("bot-row-name"));
    const card = await screen.findByTestId("bot-profile-card");
    expect(within(card).queryByTestId("bot-profile-working")).toBeNull();

    act(() =>
      tab.session.emit(
        snapshot({ trunk: replying("Ran bun test"), threads: {} }),
      ),
    );
    const working = within(card).getByTestId("bot-profile-working");
    expect(working.textContent).toBe("Working in Tracy · 1m 23sRan bun test");

    act(() =>
      tab.session.emit({
        kind: "activity",
        target: { kind: "trunk" },
        entry: {
          state: "idle",
          startedAt: null,
          step: null,
          requestId: null,
          reason: null,
        },
        hasBinaryPayload: false,
      }),
    );
    expect(within(card).queryByTestId("bot-profile-working")).toBeNull();
  });

  it("says a thread's turn is in a thread while the trunk is idle", async () => {
    const user = userEvent.setup();
    const tab = mount([botReply()], PERSON);
    await user.click(screen.getByTestId("bot-row-name"));
    const card = await screen.findByTestId("bot-profile-card");
    act(() =>
      tab.session.emit(
        snapshot({ trunk: null, threads: { "thread-1": replying(null) } }),
      ),
    );
    expect(within(card).getByTestId("bot-profile-working").textContent).toBe(
      "Working in a thread · 1m 23s",
    );
  });

  it("opens the bot's activity and says who may message it, for a person's bot and a team's", async () => {
    const user = userEvent.setup();
    const tab = mount([botReply()], PERSON);

    await user.click(screen.getByTestId("bot-row-name"));
    const card = await screen.findByTestId("bot-profile-card");
    expect(within(card).getByTestId("bot-profile-access").textContent).toBe(
      "Only you",
    );
    expect(card.textContent).toContain("Managed by Olive Owner");
    await user.click(within(card).getByTestId("bot-profile-view-activity"));
    expect(tab.openActivity).toHaveBeenCalledTimes(1);

    cleanup();
    mount([botReply()], TEAM);
    await user.click(screen.getByTestId("bot-row-name"));
    expect(
      within(await screen.findByTestId("bot-profile-card")).getByTestId(
        "bot-profile-access",
      ).textContent,
    ).toBe("Members of Acme");
  });
});
