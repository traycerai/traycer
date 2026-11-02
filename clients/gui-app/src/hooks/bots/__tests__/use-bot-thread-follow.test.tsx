import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  useBotThreadFollowSetMutation,
  useBotThreadFollowsQuery,
} from "@/hooks/bots/use-bot-thread-follow";
import {
  createFollowHostFixture,
  type FollowHostFixture,
} from "./bot-thread-follow-test-support";

// The follow hooks over a real host client and QueryClient; only the viewer
// id, the error toast and the host transport are faked.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "user-1",
}));
const toast = vi.hoisted(() => ({
  fromHostError: vi.fn<(error: unknown, fallback: string) => void>(),
}));
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: toast.fromHostError,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(fixture: FollowHostFixture) {
  return renderHook(
    () => ({
      follows: useBotThreadFollowsQuery(fixture.client, BOT_ID, true),
      update: useBotThreadFollowSetMutation(fixture.client),
    }),
    { wrapper: fixture.Wrapper },
  );
}

describe("useBotThreadFollowSetMutation", () => {
  it("shows the new state, as a manual follow, before the host answers, then settles on the re-read", async () => {
    const fixture = createFollowHostFixture({
      "thread-a": { state: "following", reason: "participated" },
    });
    const { result } = mount(fixture);
    await waitFor(() => {
      expect(result.current.follows.data?.follows["thread-a"].state).toBe(
        "following",
      );
    });
    expect(fixture.reads.count).toBe(1);

    fixture.control.holdRead = true;
    act(() => {
      result.current.update.mutate({
        botId: BOT_ID,
        threadId: "thread-a",
        state: "unfollowed",
      });
    });
    // The write is answered and its re-read is held: what shows is the write.
    await waitFor(() => {
      expect(fixture.control.releaseRead).not.toBeNull();
    });
    expect(result.current.follows.data?.follows["thread-a"]).toEqual({
      state: "unfollowed",
      reason: "manual",
    });
    act(() => {
      fixture.control.releaseRead?.();
    });
    await waitFor(() => {
      expect(result.current.update.isPending).toBe(false);
    });
    expect(fixture.reads.count).toBe(2);
    expect(fixture.writes).toEqual([
      { botId: BOT_ID, threadId: "thread-a", state: "unfollowed" },
    ]);
  });

  it("writes into every cached read of the bot's follows at once", async () => {
    const fixture = createFollowHostFixture({});
    const first = mount(fixture);
    // A second observer of the same cached read.
    const second = renderHook(
      () => useBotThreadFollowsQuery(fixture.client, BOT_ID, true),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(first.result.current.follows.data).toBeDefined();
    });
    fixture.control.holdRead = true;
    act(() => {
      first.result.current.update.mutate({
        botId: BOT_ID,
        threadId: "thread-b",
        state: "following",
      });
    });
    await waitFor(() => {
      expect(fixture.control.releaseRead).not.toBeNull();
    });
    const manual = { state: "following", reason: "manual" };
    expect(first.result.current.follows.data?.follows["thread-b"]).toEqual(
      manual,
    );
    expect(second.result.current.data?.follows["thread-b"]).toEqual(manual);
    act(() => {
      fixture.control.releaseRead?.();
    });
    await waitFor(() => {
      expect(first.result.current.update.isPending).toBe(false);
    });
  });

  it("puts the earlier state back when the write is refused, and reads again", async () => {
    const fixture = createFollowHostFixture({
      "thread-a": { state: "following", reason: "mentioned" },
    });
    const { result } = mount(fixture);
    await waitFor(() => {
      expect(result.current.follows.data).toBeDefined();
    });
    fixture.control.refuse = true;
    fixture.control.holdRead = true;

    act(() => {
      result.current.update.mutate({
        botId: BOT_ID,
        threadId: "thread-a",
        state: "unfollowed",
      });
    });
    await waitFor(() => {
      expect(toast.fromHostError).toHaveBeenCalledTimes(1);
    });
    expect(toast.fromHostError.mock.calls[0][1]).toBe(
      "Couldn't unfollow the thread.",
    );
    expect(result.current.follows.data?.follows["thread-a"]).toEqual({
      state: "following",
      reason: "mentioned",
    });
    // Settled by a re-read even though the write failed.
    await waitFor(() => {
      expect(fixture.control.releaseRead).not.toBeNull();
    });
    expect(fixture.reads.count).toBe(2);
    act(() => {
      fixture.control.releaseRead?.();
    });
  });
});
