import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  useBotMarkChannelRead,
  useBotReadCursorAdvanceMutation,
  useBotReadCursorQuery,
} from "@/hooks/bots/use-bot-read-cursor";
import {
  createReadCursorHostFixture,
  type ReadCursorHostFixture,
} from "./bot-read-cursor-test-support";

// The read-cursor hooks over a real host client and QueryClient; only the
// viewer id and the host transport are faked.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CHANNEL = "channel-1";

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "user-1",
}));

const mocks = vi.hoisted(() => ({
  fixture: null as ReadCursorHostFixture | null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.fixture?.client ?? null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

afterEach(() => {
  mocks.fixture = null;
  cleanup();
  vi.clearAllMocks();
});

function position(seq: number) {
  return { messageId: `m-${String(seq)}`, seq };
}

describe("useBotReadCursorAdvanceMutation", () => {
  it("puts the cursor the host answered into the cached read, with no re-read", async () => {
    const fixture = createReadCursorHostFixture({
      cursors: { [CHANNEL]: position(1_000) },
      latest: { [CHANNEL]: position(3_000) },
      follows: {},
    });
    const { result } = renderHook(
      () => ({
        read: useBotReadCursorQuery(fixture.client, BOT_ID, true),
        advance: useBotReadCursorAdvanceMutation(fixture.client),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.read.data).toBeDefined();
    });
    const readsBefore = fixture.reads.count;

    act(() => {
      result.current.advance.mutate({
        botId: BOT_ID,
        conversationId: CHANNEL,
        ...position(3_000),
      });
    });

    await waitFor(() => {
      expect(result.current.read.data?.cursors[CHANNEL]).toEqual(
        position(3_000),
      );
    });
    expect(fixture.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL, ...position(3_000) },
    ]);
    expect(fixture.reads.count).toBe(readsBefore);
  });

  it("adds a cursor for a conversation the read held none for", async () => {
    const fixture = createReadCursorHostFixture({
      cursors: {},
      latest: { [CHANNEL]: position(3_000) },
      follows: {},
    });
    const { result } = renderHook(
      () => ({
        read: useBotReadCursorQuery(fixture.client, BOT_ID, true),
        advance: useBotReadCursorAdvanceMutation(fixture.client),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.read.data).toBeDefined();
    });

    act(() => {
      result.current.advance.mutate({
        botId: BOT_ID,
        conversationId: CHANNEL,
        ...position(3_000),
      });
    });

    await waitFor(() => {
      expect(result.current.read.data?.cursors[CHANNEL]).toEqual(
        position(3_000),
      );
    });
  });

  it("never moves a cached cursor back when the host answers an older one", async () => {
    const fixture = createReadCursorHostFixture({
      cursors: { [CHANNEL]: position(5_000) },
      latest: { [CHANNEL]: position(5_000) },
      follows: {},
    });
    // A host that has not yet seen the 5,000 cursor answers the 2,000 one.
    fixture.advanceAnswers.set(CHANNEL, position(2_000));
    const { result } = renderHook(
      () => ({
        read: useBotReadCursorQuery(fixture.client, BOT_ID, true),
        advance: useBotReadCursorAdvanceMutation(fixture.client),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.read.data).toBeDefined();
    });

    act(() => {
      result.current.advance.mutate({
        botId: BOT_ID,
        conversationId: CHANNEL,
        ...position(2_000),
      });
    });

    await waitFor(() => {
      expect(result.current.advance.isSuccess).toBe(true);
    });
    expect(result.current.read.data?.cursors[CHANNEL]).toEqual(position(5_000));
  });

  it("leaves another bot's cached read alone", async () => {
    const fixture = createReadCursorHostFixture({
      cursors: { [CHANNEL]: position(1_000) },
      latest: { [CHANNEL]: position(3_000) },
      follows: {},
    });
    const { result } = renderHook(
      () => ({
        other: useBotReadCursorQuery(fixture.client, OTHER_BOT_ID, true),
        advance: useBotReadCursorAdvanceMutation(fixture.client),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.other.data).toBeDefined();
    });

    act(() => {
      result.current.advance.mutate({
        botId: BOT_ID,
        conversationId: CHANNEL,
        ...position(3_000),
      });
    });

    await waitFor(() => {
      expect(result.current.advance.isSuccess).toBe(true);
    });
    expect(result.current.other.data?.cursors[CHANNEL]).toEqual(
      position(1_000),
    );
  });
});

describe("useBotMarkChannelRead", () => {
  it("advances the channel and each followed thread behind its newest row to the host, and leaves caught-up and unfollowed ones alone", async () => {
    const fixture = createReadCursorHostFixture({
      cursors: {
        [CHANNEL]: position(1_000),
        "thread-caught-up": position(2_000),
      },
      latest: {
        [CHANNEL]: position(3_000),
        "thread-a": position(4_000),
        "thread-caught-up": position(2_000),
        "thread-unfollowed": position(5_000),
      },
      follows: {
        "thread-a": { state: "following", reason: "manual" },
        "thread-caught-up": { state: "following", reason: "manual" },
        "thread-unfollowed": { state: "unfollowed", reason: "manual" },
      },
    });
    mocks.fixture = fixture;
    const { result } = renderHook(
      () => useBotMarkChannelRead(BOT_ID, "host-1", CHANNEL),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });

    act(() => {
      result.current?.();
    });

    await waitFor(() => {
      expect(fixture.advances).toHaveLength(2);
    });
    expect(fixture.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL, ...position(3_000) },
      { botId: BOT_ID, conversationId: "thread-a", ...position(4_000) },
    ]);
  });

  it("offers nothing without a channel", () => {
    const fixture = createReadCursorHostFixture({
      cursors: {},
      latest: {},
      follows: {},
    });
    mocks.fixture = fixture;
    const { result } = renderHook(
      () => useBotMarkChannelRead(BOT_ID, "host-1", null),
      { wrapper: fixture.Wrapper },
    );

    expect(result.current).toBeNull();
  });
});
