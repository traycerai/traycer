/**
 * The thread header's actions menu (decision 137), over a real follows
 * query and mutation against a host that keeps the person's follows. Only the
 * viewer id, the method support and the tab's host client are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { BotThreadFollow } from "@traycer/protocol/host/bot/schemas";
import {
  createFollowHostFixture,
  type FollowHostFixture,
} from "@/hooks/bots/__tests__/bot-thread-follow-test-support";

const mocks = vi.hoisted(() => ({
  follows: null as FollowHostFixture | null,
  supported: true,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.follows?.client ?? null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.supported,
}));

import {
  BotThreadFollowControl,
  BotThreadRowMenu,
} from "@/components/bots/bot-thread-follow";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THREAD_ID = "thread-a";

function mount(
  initial: Record<string, BotThreadFollow>,
  postedByViewer: boolean,
): FollowHostFixture {
  const fixture = createFollowHostFixture(initial);
  mocks.follows = fixture;
  render(
    <fixture.Wrapper>
      <BotThreadFollowControl
        botId={BOT_ID}
        hostId="host-1"
        threadId={THREAD_ID}
        postedByViewer={postedByViewer}
      />
    </fixture.Wrapper>,
  );
  return fixture;
}

beforeEach(() => {
  mocks.supported = true;
});

afterEach(() => {
  cleanup();
  mocks.follows = null;
});

async function openMenu(user: UserEvent): Promise<void> {
  await user.click(await screen.findByTestId("bot-thread-menu"));
}

describe("<BotThreadFollowControl />", () => {
  it("is one Thread actions button, with no Follow button or Following trigger and no Following text while closed", async () => {
    mount(
      { [THREAD_ID]: { state: "following", reason: "participated" } },
      true,
    );

    const menu = await screen.findByTestId("bot-thread-menu");
    expect(menu.getAttribute("aria-label")).toBe("Thread actions");
    expect(screen.queryByTestId("bot-thread-follow")).toBeNull();
    expect(screen.queryByTestId("bot-thread-following")).toBeNull();
    expect(screen.queryByTestId("bot-thread-following-reason")).toBeNull();
    expect(document.body.textContent).not.toContain("Following");
  });

  it("offers Follow in the menu on an unfollowed thread, with no state label, and sends the follow", async () => {
    const user = userEvent.setup();
    const fixture = mount({}, false);

    await openMenu(user);

    const item = await screen.findByTestId("bot-thread-follow");
    expect(item.textContent).toBe("Follow");
    expect(screen.queryByTestId("bot-thread-following-reason")).toBeNull();
    expect(screen.queryByTestId("bot-thread-unfollow")).toBeNull();
    expect(screen.queryByText("Open thread")).toBeNull();
    await user.click(item);
    await waitFor(() =>
      expect(fixture.writes).toEqual([
        { botId: BOT_ID, threadId: THREAD_ID, state: "following" },
      ]),
    );
  });

  it.each([
    ["participated", true, "Following · you posted"],
    ["participated", false, "Following · you replied"],
    ["mentioned", false, "Following · you were mentioned"],
    ["manual", false, "Following · you chose to"],
  ] as const)(
    "labels a %s follow (viewer posted: %s) in the menu as %s",
    async (reason, postedByViewer, text) => {
      const user = userEvent.setup();
      mount({ [THREAD_ID]: { state: "following", reason } }, postedByViewer);

      await openMenu(user);

      expect(
        (await screen.findByTestId("bot-thread-following-reason")).textContent,
      ).toBe(text);
    },
  );

  it("unfollows from the menu of a followed thread, which has no Open thread", async () => {
    const user = userEvent.setup();
    const fixture = mount(
      { [THREAD_ID]: { state: "following", reason: "participated" } },
      true,
    );

    await openMenu(user);
    expect(screen.queryByTestId("bot-thread-follow")).toBeNull();
    expect(screen.queryByText("Open thread")).toBeNull();
    const item = await screen.findByTestId("bot-thread-unfollow");
    expect(item.textContent).toBe("Unfollow");
    await user.click(item);

    await waitFor(() =>
      expect(fixture.writes).toEqual([
        { botId: BOT_ID, threadId: THREAD_ID, state: "unfollowed" },
      ]),
    );
  });

  it("reads an unfollowed row as not followed", async () => {
    const user = userEvent.setup();
    mount({ [THREAD_ID]: { state: "unfollowed", reason: "manual" } }, false);

    await openMenu(user);

    expect(await screen.findByTestId("bot-thread-follow")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-following-reason")).toBeNull();
  });

  it("draws nothing on a host without the methods", () => {
    mocks.supported = false;
    mount({}, false);

    expect(screen.queryByTestId("bot-thread-menu")).toBeNull();
    expect(screen.queryByTestId("bot-thread-follow")).toBeNull();
    expect(screen.queryByTestId("bot-thread-following")).toBeNull();
  });
});

describe("<BotThreadRowMenu />", () => {
  it("still offers Open thread and Follow in a Threads card's menu", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    mocks.follows = createFollowHostFixture({});
    render(
      <mocks.follows.Wrapper>
        <BotThreadRowMenu
          botId={BOT_ID}
          threadId={THREAD_ID}
          following={false}
          onOpenThread={onOpenThread}
        />
      </mocks.follows.Wrapper>,
    );

    await user.click(screen.getByTestId("bot-thread-row-menu"));

    const open = await screen.findByTestId("bot-thread-row-open");
    expect(open.textContent).toBe("Open thread");
    expect(screen.getByTestId("bot-thread-row-follow").textContent).toBe(
      "Follow",
    );
    await user.click(open);
    expect(onOpenThread).toHaveBeenCalledTimes(1);
  });
});
