/**
 * The thread panel's header carries the follow menu (decision 137). The REAL
 * panel runs over a real follows query and mutation against a host that keeps
 * the person's follows; only the viewer id, the tab's host client, the error
 * toast and the session registry are replaced. Controls are found by role and
 * accessible name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  createFollowHostFixture,
  type FollowHostFixture,
} from "@/hooks/bots/__tests__/bot-thread-follow-test-support";
import { BotThreadPanel } from "@/components/bots/bot-thread-panel";
import type { BotThreadFollow } from "@traycer/protocol/host/bot/schemas";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const mocks = vi.hoisted(() => ({
  follows: null as FollowHostFixture | null,
  toastFromHostError: vi.fn<(error: Error, fallback: string) => void>(),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.follows?.client ?? null,
}));
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: mocks.toastFromHostError,
}));
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
}));

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const CONVERSATION_ID = "conversation-channel";
const THREAD_ID = "thread-1";

const THREAD: BotThreadSummary = {
  threadId: THREAD_ID,
  conversationId: CONVERSATION_ID,
  sessionChatId: "session-1",
  anchor: {
    messageId: "anchor-1",
    requestId: "req-1",
    senderUserId: null,
    sentAt: 1_000,
    resolvedAt: null,
    excerpt: null,
  },
  replyCount: 1,
  lastReplyAt: 2_000,
  openRequestCount: 1,
  costUsd: null,
};

const MANUAL_FOLLOW: BotThreadFollow = { state: "following", reason: "manual" };

function mountPanel(
  initial: Record<string, BotThreadFollow>,
): FollowHostFixture {
  const fixture = createFollowHostFixture(initial);
  mocks.follows = fixture;
  render(
    <fixture.Wrapper>
      <BotTestRunnerHost>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotThreadPanel
              botId={BOT_ID}
              hostId={HOST_ID}
              boundHostId={HOST_ID}
              imageReach="none"
              answerReach="each"
              botTitle="Release Bot"
              conversationId={CONVERSATION_ID}
              originMessageId="anchor-1"
              sent={null}
              thread={{
                kind: "listed",
                retry: null,
                thread: THREAD,
                sendable: true,
              }}
              tasks={[]}
              anchorSenderLabel={() => "You"}
              resolveMember={() => null}
              onClose={vi.fn()}
              onEditPost={vi.fn()}
              onOpenTurn={vi.fn()}
              onOpenSession={vi.fn()}
              landOn={null}
              quote={null}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </BotTestRunnerHost>
    </fixture.Wrapper>,
  );
  return fixture;
}

beforeEach(() => {
  recordNegotiatedHostManifest(HOST_ID, {
    "bot.threadFollow.read": { major: 1, minor: 0 },
    "bot.threadFollow.set": { major: 1, minor: 0 },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  mocks.follows = null;
  mocks.toastFromHostError.mockClear();
});

async function openMenu(user: UserEvent): Promise<void> {
  await user.click(
    await screen.findByRole("button", { name: "Thread actions" }),
  );
}

async function choose(user: UserEvent, name: string): Promise<void> {
  await user.click(await screen.findByRole("menuitem", { name }));
}

async function expectUnfollowed(user: UserEvent): Promise<void> {
  await openMenu(user);
  await screen.findByRole("menuitem", { name: "Follow" });
  expect(screen.queryByText(/Following/)).toBeNull();
  await user.keyboard("{Escape}");
}

async function expectFollowedByChoice(user: UserEvent): Promise<void> {
  await openMenu(user);
  await screen.findByText("Following · you chose to");
  expect(screen.getByRole("menuitem", { name: "Unfollow" })).toBeTruthy();
  await user.keyboard("{Escape}");
}

describe("<BotThreadPanel /> the thread's follow menu", () => {
  it("puts Thread actions after Thread session in the header, and shows no follow state while the menu is closed", async () => {
    mountPanel({ [THREAD_ID]: MANUAL_FOLLOW });

    const actions = await screen.findByRole("button", {
      name: "Thread actions",
    });
    const session = screen.getByRole("button", { name: "Thread session" });
    const header = screen.getByRole("banner");
    expect(header.contains(session)).toBe(true);
    expect(header.contains(actions)).toBe(true);
    expect(
      session.compareDocumentPosition(actions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(header).queryByText(/Following/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
  });

  it("follows from the menu at once, and flips back with a toast when the host refuses", async () => {
    const user = userEvent.setup();
    const fixture = mountPanel({});
    fixture.control.refuse = true;

    await openMenu(user);
    await choose(user, "Follow");

    await waitFor(() =>
      expect(mocks.toastFromHostError).toHaveBeenCalledTimes(1),
    );
    expect(mocks.toastFromHostError.mock.calls[0][1]).toBe(
      "Couldn't follow the thread.",
    );
    expect(fixture.writes).toEqual([
      { botId: BOT_ID, threadId: THREAD_ID, state: "following" },
    ]);
    await expectUnfollowed(user);
  });

  it("unfollows from the menu of a followed thread, and flips back with a toast when the host refuses", async () => {
    const user = userEvent.setup();
    const fixture = mountPanel({ [THREAD_ID]: MANUAL_FOLLOW });
    fixture.control.refuse = true;

    await openMenu(user);
    await choose(user, "Unfollow");

    await waitFor(() =>
      expect(mocks.toastFromHostError).toHaveBeenCalledTimes(1),
    );
    expect(mocks.toastFromHostError.mock.calls[0][1]).toBe(
      "Couldn't unfollow the thread.",
    );
    expect(fixture.writes).toEqual([
      { botId: BOT_ID, threadId: THREAD_ID, state: "unfollowed" },
    ]);
    await expectFollowedByChoice(user);
  });

  it("shows the flipped state while the write is held, sends no second write on reopening, and settles on it once answered", async () => {
    const user = userEvent.setup();
    const fixture = mountPanel({});
    fixture.control.holdWrite = true;

    await openMenu(user);
    await choose(user, "Follow");
    await waitFor(() => expect(fixture.control.releaseWrites).toHaveLength(1));

    await expectFollowedByChoice(user);
    expect(fixture.writes).toHaveLength(1);

    fixture.control.releaseWrites[0]();
    await waitFor(() => expect(fixture.reads.count).toBe(2));
    await expectFollowedByChoice(user);
    expect(fixture.writes).toEqual([
      { botId: BOT_ID, threadId: THREAD_ID, state: "following" },
    ]);
  });
  it("sends the opposite choice at once while the first write is held, shows Following again once the first write's re-read lands, and settles on not followed after the second", async () => {
    const user = userEvent.setup();
    const fixture = mountPanel({});
    fixture.control.holdWrite = true;

    await openMenu(user);
    await choose(user, "Follow");
    await waitFor(() => expect(fixture.control.releaseWrites).toHaveLength(1));
    await openMenu(user);
    await choose(user, "Unfollow");
    await waitFor(() => expect(fixture.control.releaseWrites).toHaveLength(2));

    expect(fixture.writes).toEqual([
      { botId: BOT_ID, threadId: THREAD_ID, state: "following" },
      { botId: BOT_ID, threadId: THREAD_ID, state: "unfollowed" },
    ]);
    await expectUnfollowed(user);

    fixture.control.releaseWrites[0]();
    await waitFor(() => expect(fixture.reads.count).toBe(2));
    await expectFollowedByChoice(user);

    fixture.control.releaseWrites[1]();
    await waitFor(() => expect(fixture.reads.count).toBe(3));
    await expectUnfollowed(user);
  });
});
