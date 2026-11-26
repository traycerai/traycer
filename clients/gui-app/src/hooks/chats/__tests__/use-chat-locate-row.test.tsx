import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ChatLocateRowResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  useChatLocateRow,
  useChatLocateRowAnswer,
  type ChatLocateRowAnswer,
} from "@/hooks/chats/use-chat-locate-row";

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
  readonly preflight: (() => void) | undefined;
}

const answer = vi.hoisted<{ value: ChatLocateRowResponse | undefined }>(() => ({
  value: undefined,
}));
const captured = vi.hoisted<{ value: CapturedHostQuery | null }>(() => ({
  value: null,
}));
/** What the query reports besides its data: a request in flight, a rejection. */
const status = vi.hoisted<{
  fetching: boolean;
  rejected: boolean;
  error: Error | null;
}>(() => ({
  fetching: false,
  rejected: false,
  error: null,
}));

// No directory entry and no witness: the chat stays on its own host, which
// is what `useChatServingHostId` answers in production today.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQuery) => {
    captured.value = args;
    return {
      data: answer.value,
      isFetching: status.fetching,
      isError: status.rejected,
      error: status.error,
    };
  },
}));

function locate(input: {
  readonly epoch: number;
  readonly response: ChatLocateRowResponse | undefined;
  readonly poolStream?: {
    readonly tileInstanceId: string;
    readonly subscriptionId: string | null;
    readonly readCurrent: () => string | null;
  };
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
      ...(input.poolStream === undefined
        ? {}
        : { poolStream: input.poolStream }),
    }),
  );
  return result.current;
}

// Every case starts from a query with no answer, nothing in flight and no
// rejection, whichever describe it is in.
beforeEach(() => {
  answer.value = undefined;
  captured.value = null;
  status.fetching = false;
  status.rejected = false;
  status.error = null;
});

describe("useChatLocateRow", () => {
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

  it("keys same-epoch pool locate requests by tile and subscription", () => {
    locate({
      epoch: 12,
      response: { found: true, ordinal: 17, epoch: 12 },
      poolStream: {
        tileInstanceId: "tile-direct",
        subscriptionId: "pool-subscription-a",
        readCurrent: () => "pool-subscription-a",
      },
    });
    const firstKey = captured.value?.cacheKeyIdentity;

    locate({
      epoch: 12,
      response: { found: true, ordinal: 29, epoch: 12 },
      poolStream: {
        tileInstanceId: "tile-secondary",
        subscriptionId: "pool-subscription-b",
        readCurrent: () => "pool-subscription-b",
      },
    });

    expect(firstKey).toEqual([12, "tile-direct", "pool-subscription-a"]);
    expect(captured.value?.cacheKeyIdentity).toEqual([
      12,
      "tile-secondary",
      "pool-subscription-b",
    ]);
  });

  it("drops an answer from the replaced pool subscription even when the epoch and target still match", () => {
    expect(
      locate({
        epoch: 12,
        response: { found: true, ordinal: 29, epoch: 12 },
        poolStream: {
          tileInstanceId: "tile-direct",
          subscriptionId: "pool-subscription-old",
          readCurrent: () => "pool-subscription-new",
        },
      }),
    ).toBeNull();
    expect(captured.value?.options?.enabled).toBe(false);
    expect(captured.value?.cacheKeyIdentity).toEqual([
      12,
      "tile-direct",
      "pool-subscription-old",
    ]);
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

describe("useChatLocateRowAnswer", () => {
  function answerNow(epoch: number): ChatLocateRowAnswer {
    const { result } = renderHook(() =>
      useChatLocateRowAnswer({
        client: null,
        epicId: "epic-1",
        chatId: "chat-1",
        target: { kind: "block", blockId: "b-1" },
        epoch,
      }),
    );
    return result.current;
  }

  it("keeps the difference between a miss and no answer yet", () => {
    answer.value = { found: false };
    expect(answerNow(7)).toEqual({ status: "missing", cause: "absent" });

    answer.value = undefined;
    status.rejected = true;
    status.error = new Error("the connection dropped");
    expect(answerNow(7)).toEqual({ status: "missing", cause: "failed" });

    status.rejected = false;
    expect(answerNow(7)).toEqual({ status: "waiting" });
  });

  it("reads waiting while a new request runs over a cached miss, and missing again if it ends in one", () => {
    answer.value = { found: false };
    status.fetching = true;
    expect(answerNow(7)).toEqual({ status: "waiting" });

    status.fetching = false;
    expect(answerNow(7)).toEqual({ status: "missing", cause: "absent" });
  });

  it("reads a host that does not locate rows as unsupported, which says nothing about the row", () => {
    answer.value = undefined;
    status.rejected = true;
    status.error = new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: "the host does not locate rows",
      requestId: "request-1",
      method: "chat.locateRow",
      fatalDetails: null,
    });
    expect(answerNow(7)).toEqual({ status: "missing", cause: "unsupported" });
  });

  it("reads any other host rejection as failed", () => {
    answer.value = undefined;
    status.rejected = true;
    status.error = new HostRpcError({
      code: "RPC_ERROR",
      message: "the host could not read the chat",
      requestId: "request-2",
      method: "chat.locateRow",
      fatalDetails: null,
    });
    expect(answerNow(7)).toEqual({ status: "missing", cause: "failed" });
  });

  it("reads a found row as found whether or not a request runs", () => {
    answer.value = { found: true, ordinal: 42, epoch: 7 };
    status.fetching = true;
    expect(answerNow(7)).toEqual({ status: "found", ordinal: 42 });
  });
});
