import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { MutateOptions, UseMutationResult } from "@tanstack/react-query";
import type {
  BotReadCursorAdvanceRequest,
  BotReadCursorAdvanceResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  useBotReadCursorAdvanceMutation,
  type BotReadCursorAdvanceVariables,
} from "@/hooks/bots/use-bot-read-cursor";
import {
  createReadCursorHostFixture,
  removeNativeAbortAny,
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

type AdvanceSuccessCallback = NonNullable<
  MutateOptions<
    BotReadCursorAdvanceResponse,
    HostRpcError,
    BotReadCursorAdvanceVariables
  >["onSuccess"]
>;

type AdvanceResult = UseMutationResult<
  BotReadCursorAdvanceResponse,
  HostRpcError,
  BotReadCursorAdvanceVariables
>;

/**
 * Renders the hook. The mutation cache reports a terminal state before the
 * observer re-renders the hook (TanStack notifies observers on its own
 * scheduler), so `until` resolves from the render that first shows a result
 * `test` accepts, never from the cache's event.
 */
function mount() {
  const waiters: Array<{
    readonly test: (result: AdvanceResult) => boolean;
    readonly resolve: () => void;
  }> = [];
  const view = renderHook(
    () => {
      const result = useBotReadCursorAdvanceMutation(fixture.client);
      for (const waiter of waiters.splice(0)) {
        if (waiter.test(result)) waiter.resolve();
        else waiters.push(waiter);
      }
      return result;
    },
    { wrapper: fixture.Wrapper },
  );
  const until = (test: (result: AdvanceResult) => boolean): Promise<void> =>
    new Promise<void>((resolve) => {
      if (test(view.result.current)) resolve();
      else waiters.push({ test, resolve });
    });
  return { ...view, until };
}

describe("the advance mutation's result", () => {
  it("calls a per-call onSuccess with the answer and the variables the caller passed", async () => {
    let called = (): void => undefined;
    const answered = new Promise<void>((resolve) => {
      called = resolve;
    });
    const onSuccess = vi.fn<AdvanceSuccessCallback>(() => {
      called();
    });
    const { result } = mount();

    act(() => {
      result.current.mutate(REQUEST, { onSuccess });
    });
    await act(async () => {
      await answered;
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.[0]).toEqual({
      cursor: { messageId: "m-new", seq: 2_000 },
    });
    expect(onSuccess.mock.calls[0]?.[1]).toEqual(REQUEST);
  });

  it("reports the caller's variables on its result", async () => {
    const { result, until } = mount();

    const succeeded = until((current) => current.isSuccess);
    act(() => {
      result.current.mutate(REQUEST);
    });
    await act(async () => {
      await succeeded;
    });

    expect(result.current.variables).toEqual(REQUEST);
  });

  it("reports the refusal as its error and returns to idle on reset", async () => {
    fixture.refuseAdvances.value = true;
    const { result, until } = mount();

    const failed = until((current) => current.isError);
    act(() => {
      result.current.mutate(REQUEST);
    });
    await act(async () => {
      await failed;
    });
    expect(result.current.error).not.toBeNull();

    const idle = until((current) => current.isIdle);
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await idle;
    });

    expect(result.current.isIdle).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.variables).toBeUndefined();
  });
});

describe("the advance mutation's supplied retirement signal, without AbortSignal.any", () => {
  let restoreAbortAny = (): void => undefined;
  beforeEach(() => {
    restoreAbortAny = removeNativeAbortAny();
  });
  afterEach(() => {
    restoreAbortAny();
  });

  /** The abort listeners the hook put on `signal` and took off again, in order. */
  function watchAbortListeners(signal: AbortSignal) {
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    vi.spyOn(signal, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (type === "abort") added.push(listener);
        add(type, listener, options);
      },
    );
    vi.spyOn(signal, "removeEventListener").mockImplementation(
      (type, listener, options) => {
        if (type === "abort") removed.push(listener);
        remove(type, listener, options);
      },
    );
    return { added, removed };
  }

  it("dispatches nothing and rejects when the signal is already aborted", async () => {
    const { result } = mount();
    const retired = new AbortController();
    retired.abort();

    await expect(
      (async () =>
        result.current.mutateAsync({ ...REQUEST, signal: retired.signal }))(),
    ).rejects.toBeDefined();

    expect(fixture.advances).toEqual([]);
  });

  it("takes its abort listener off the signal once the advance succeeds", async () => {
    const { result } = mount();
    const live = new AbortController();
    const listeners = watchAbortListeners(live.signal);

    await act(async () => {
      await result.current.mutateAsync({ ...REQUEST, signal: live.signal });
    });

    expect(fixture.advances).toEqual([REQUEST]);
    expect(listeners.added).not.toHaveLength(0);
    expect(listeners.removed).toEqual(listeners.added);
  });

  it("takes its abort listener off the signal once the advance is refused", async () => {
    fixture.refuseAdvances.value = true;
    const { result } = mount();
    const live = new AbortController();
    const listeners = watchAbortListeners(live.signal);

    await act(async () => {
      await expect(
        result.current.mutateAsync({ ...REQUEST, signal: live.signal }),
      ).rejects.toBeDefined();
    });

    expect(listeners.added).not.toHaveLength(0);
    expect(listeners.removed).toEqual(listeners.added);
  });
});
