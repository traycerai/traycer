/**
 * The thread header's follow control (decision 137), over a real follows
 * query and mutation against a host that keeps the person's follows. Only the
 * viewer id, the method support and the tab's host client are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import { BotThreadFollowControl } from "@/components/bots/bot-thread-follow";

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

describe("<BotThreadFollowControl />", () => {
  it("offers Follow on an unfollowed thread, and says Following once the follow lands", async () => {
    const user = userEvent.setup();
    const fixture = mount({}, false);

    await user.click(await screen.findByTestId("bot-thread-follow"));

    const following = await screen.findByTestId("bot-thread-following");
    expect(following.textContent).toContain("Following");
    expect(screen.getByTestId("bot-thread-following-reason").textContent).toBe(
      "· you chose to",
    );
    expect(fixture.writes).toEqual([
      { botId: BOT_ID, threadId: THREAD_ID, state: "following" },
    ]);
  });

  it.each([
    ["participated", true, "· you posted"],
    ["participated", false, "· you replied"],
    ["mentioned", false, "· you were mentioned"],
    ["manual", false, "· you chose to"],
  ] as const)(
    "gives a %s follow (viewer posted: %s) the reason %s",
    async (reason, postedByViewer, text) => {
      mount({ [THREAD_ID]: { state: "following", reason } }, postedByViewer);

      expect(
        (await screen.findByTestId("bot-thread-following-reason")).textContent,
      ).toBe(text);
    },
  );

  it("unfollows from its menu and goes back to Follow", async () => {
    const user = userEvent.setup();
    const fixture = mount(
      { [THREAD_ID]: { state: "following", reason: "participated" } },
      true,
    );

    await user.click(await screen.findByTestId("bot-thread-following"));
    await user.click(await screen.findByTestId("bot-thread-unfollow"));

    expect(await screen.findByTestId("bot-thread-follow")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-following")).toBeNull();
    await waitFor(() =>
      expect(fixture.writes).toEqual([
        { botId: BOT_ID, threadId: THREAD_ID, state: "unfollowed" },
      ]),
    );
  });

  it("reads an unfollowed row as not followed", async () => {
    mount({ [THREAD_ID]: { state: "unfollowed", reason: "manual" } }, false);

    expect(await screen.findByTestId("bot-thread-follow")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-following")).toBeNull();
  });

  it("draws nothing on a host without the methods", () => {
    mocks.supported = false;
    mount({}, false);

    expect(screen.queryByTestId("bot-thread-follow")).toBeNull();
    expect(screen.queryByTestId("bot-thread-following")).toBeNull();
  });
});
