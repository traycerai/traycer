import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BotReadCursorAdvanceRequest } from "@traycer/protocol/host/bot/schemas";
import { useBotReadCursorAdvanceMutation } from "@/hooks/bots/use-bot-read-cursor";
import {
  createReadCursorHostFixture,
  type ReadCursorHostFixture,
} from "./bot-read-cursor-test-support";

// The advance hook is the mutation's own result: a per-call callback gets the
// variables the caller passed, and `variables`, `error` and `reset` are the
// real mutation's, over a real host client and QueryClient.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST: BotReadCursorAdvanceRequest = {
  botId: BOT_ID,
  conversationId: "channel-1",
  messageId: "m-new",
  seq: 2_000,
};

let fixture: ReadCursorHostFixture;
beforeEach(() => {
  fixture = createReadCursorHostFixture({ cursors: {}, latest: {} });
});

afterEach(() => {
  cleanup();
});

function mount() {
  return renderHook(() => useBotReadCursorAdvanceMutation(fixture.client), {
    wrapper: fixture.Wrapper,
  });
}

describe("the advance mutation's result", () => {
  it("calls a per-call onSuccess with the answer and the variables the caller passed", async () => {
    const onSuccess = vi.fn();
    const { result } = mount();

    act(() => {
      result.current.mutate(REQUEST, { onSuccess });
    });

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onSuccess.mock.calls[0]?.[0]).toEqual({
      cursor: { messageId: "m-new", seq: 2_000 },
    });
    expect(onSuccess.mock.calls[0]?.[1]).toEqual(REQUEST);
  });

  it("reports the caller's variables on its result", async () => {
    const { result } = mount();

    act(() => {
      result.current.mutate(REQUEST);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.variables).toEqual(REQUEST);
  });

  it("reports the refusal as its error and returns to idle on reset", async () => {
    fixture.refuseAdvances.value = true;
    const { result } = mount();

    act(() => {
      result.current.mutate(REQUEST);
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    await waitFor(() => {
      expect(result.current.isIdle).toBe(true);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.variables).toBeUndefined();
  });
});
