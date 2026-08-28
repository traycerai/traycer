import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLocateRowResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { useChatLocateRow } from "@/hooks/chats/use-chat-locate-row";

/**
 * `chat.locateRow` answers with an ORDINAL, and an ordinal means nothing
 * without the coordinate space it was numbered in. This is a unary RPC on a
 * different connection from the stream, so a restore or a compaction between
 * the host numbering the row and this hook returning the number leaves the
 * client holding a position in a space it has left - in range, fetchable, and
 * pointing at a plausible wrong row, which nothing downstream can detect.
 *
 * These pin both halves of the guard: the epoch is part of the cache key, so a
 * re-base re-asks rather than being served the previous space's answer; and the
 * answer is compared before use, so one already in flight when the re-base
 * happened is discarded rather than jumped to.
 */
interface CapturedHostQuery {
  readonly client: object | null;
  readonly method: string;
  readonly params: {
    readonly epicId: string;
    readonly chatId: string;
    readonly target: { readonly kind: string };
  };
  readonly cacheKeyIdentity: ReadonlyArray<unknown> | undefined;
  readonly options: { readonly enabled: boolean | undefined } | null;
}

const answer = vi.hoisted<{ value: ChatLocateRowResponse | undefined }>(() => ({
  value: undefined,
}));
const captured = vi.hoisted<{ value: CapturedHostQuery | null }>(() => ({
  value: null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQuery) => {
    captured.value = args;
    return { data: answer.value, isFetching: false, isError: false };
  },
}));

function locate(input: {
  readonly epoch: number;
  readonly response: ChatLocateRowResponse | undefined;
}): number | null {
  answer.value = input.response;
  const { result } = renderHook(() =>
    useChatLocateRow({
      // The hook only forwards the client; nothing here dispatches.
      client: null,
      epicId: "epic-1",
      chatId: "chat-1",
      target: { kind: "block", blockId: "b-1" },
      epoch: input.epoch,
    }),
  );
  return result.current;
}

describe("useChatLocateRow", () => {
  beforeEach(() => {
    answer.value = undefined;
    captured.value = null;
  });

  it("takes an ordinal numbered in the epoch the caller is holding", () => {
    expect(
      locate({ epoch: 7, response: { found: true, ordinal: 42, epoch: 7 } }),
    ).toBe(42);
  });

  it("discards an ordinal numbered in a superseded epoch", () => {
    // The in-flight case: the answer left the host before the re-base and
    // arrives after it. `null` puts the jump exactly where an unanswered one
    // already is - waiting, and re-asked under the new epoch.
    expect(
      locate({ epoch: 8, response: { found: true, ordinal: 42, epoch: 7 } }),
    ).toBeNull();
  });

  it("reports the opaque refusal as no answer", () => {
    expect(locate({ epoch: 7, response: { found: false } })).toBeNull();
  });

  it("varies the cache key by epoch so a re-base re-asks", () => {
    // Without this a superseded answer is simply re-served from cache, and the
    // check above never gets to see it.
    locate({ epoch: 7, response: { found: true, ordinal: 42, epoch: 7 } });
    expect(captured.value?.cacheKeyIdentity).toEqual([7]);
    locate({ epoch: 8, response: { found: true, ordinal: 42, epoch: 8 } });
    expect(captured.value?.cacheKeyIdentity).toEqual([8]);
  });

  it("stays disabled while there is no unresolved jump", () => {
    answer.value = undefined;
    const { result } = renderHook(() =>
      useChatLocateRow({
        client: null,
        epicId: "epic-1",
        chatId: "chat-1",
        target: null,
        epoch: 7,
      }),
    );

    expect(result.current).toBeNull();
    expect(captured.value?.options?.enabled).toBe(false);
  });
});
