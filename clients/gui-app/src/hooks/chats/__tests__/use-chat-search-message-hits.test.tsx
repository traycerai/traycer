import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  useChatSearchMessageHits,
  type ChatSearchSurfaceScope,
} from "@/hooks/chats/use-chat-search-message-hits";
import type {
  ChatSearchBaseRequest,
  useChatSearchResults,
} from "@/hooks/chats/use-chat-search-query";
import type { ChatSearchMergedResults } from "@/lib/chat-search/chat-search-results";

const methodSupport = vi.hoisted(() => ({ current: true as boolean | null }));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => methodSupport.current,
}));

const readiness = vi.hoisted(() => ({
  current: {
    hostId: "host-1",
    requestContextUserId: "user-1",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  },
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => readiness.current,
}));

vi.mock("@/hooks/ui/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

const useChatSearchResultsMock = vi.hoisted(() =>
  vi.fn<typeof useChatSearchResults>(),
);
vi.mock("@/hooks/chats/use-chat-search-query", () => ({
  useChatSearchResults: useChatSearchResultsMock,
}));

function setReachable(reachable: boolean) {
  methodSupport.current = reachable ? true : null;
  readiness.current = {
    hostId: "host-1",
    requestContextUserId: "user-1",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: reachable,
  };
}

function messageHit(input: {
  readonly messageId: string;
}): ChatSearchMessageHit {
  return {
    messageId: input.messageId,
    tier: "assistant",
    createdAt: Date.now(),
    interAgent: false,
    truncated: false,
    snippet: { text: "snippet text", highlights: [] },
  };
}

function messageMatch(input: {
  readonly chatId: string;
}): ChatSearchMessageMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: input.chatId,
    title: `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    matchCount: 1,
    best: messageHit({ messageId: `${input.chatId}-m1` }),
    messages: [],
  };
}

function mergedResults(
  input: Partial<ChatSearchMergedResults>,
): ChatSearchMergedResults {
  return {
    chatMatches: [],
    messageMatches: [],
    chatNextCursor: null,
    messageNextCursor: null,
    indexState: "complete",
    ...input,
  };
}

interface HitsProps {
  readonly hostId: string | null;
  readonly query: string;
  readonly scope: ChatSearchSurfaceScope | null;
}

function renderMessageHits(initialProps: HitsProps) {
  return renderHook(
    (props: HitsProps) =>
      useChatSearchMessageHits({
        client: null,
        hostId: props.hostId,
        query: props.query,
        scope: props.scope,
      }),
    { initialProps },
  );
}

function latestCall(): {
  readonly base: ChatSearchBaseRequest | null;
  readonly messageCursors: ReadonlyArray<string>;
} {
  const calls = useChatSearchResultsMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1] as [
    {
      readonly base: ChatSearchBaseRequest | null;
      readonly messageCursors: ReadonlyArray<string>;
    },
  ];
  return lastCall[0];
}

const VALID_SCOPE: ChatSearchSurfaceScope = {
  kind: "current-task",
  epicId: "epic-1",
};

afterEach(() => {
  cleanup();
  useChatSearchResultsMock.mockReset();
  setReachable(true);
});

describe("useChatSearchMessageHits: absent gates", () => {
  it("is absent when the trimmed query is shorter than 2 characters", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "idle" });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "a",
      scope: VALID_SCOPE,
    });

    expect(result.current).toEqual({ kind: "absent" });
    expect(latestCall().base).toBeNull();
  });

  it("is absent when the host is unreachable, even with a long query", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "idle" });
    setReachable(false);

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    expect(result.current).toEqual({ kind: "absent" });
    expect(latestCall().base).toBeNull();
  });

  it("is absent when the host answered the handshake without chat.search", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "idle" });
    methodSupport.current = false;

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    expect(result.current).toEqual({ kind: "absent" });
    expect(latestCall().base).toBeNull();
  });

  it("is absent when the surface has no scope", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "idle" });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: null,
    });

    expect(result.current).toEqual({ kind: "absent" });
    expect(latestCall().base).toBeNull();
  });

  it("is absent when the query hook reports the host as unsupported", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "unsupported" });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    expect(result.current).toEqual({ kind: "absent" });
  });
});

describe("useChatSearchMessageHits: pass-through statuses", () => {
  it("passes loading through", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "loading" });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    expect(result.current).toEqual({ kind: "loading" });
  });

  it("passes an error through", () => {
    useChatSearchResultsMock.mockReturnValue({
      kind: "error",
      message: "Host went away",
    });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    expect(result.current).toEqual({
      kind: "error",
      message: "Host went away",
    });
  });
});

describe("useChatSearchMessageHits: ready shape", () => {
  it("carries the merged messages, index state and loading-more flag, with showMore a function", () => {
    useChatSearchResultsMock.mockReturnValue({
      kind: "ready",
      results: mergedResults({
        messageMatches: [messageMatch({ chatId: "c1" })],
        messageNextCursor: "c1",
        indexState: "partial",
      }),
      loadingMore: false,
      loadMoreError: null,
    });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    if (result.current.kind !== "ready") {
      throw new Error("expected a ready status");
    }
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.indexState).toBe("partial");
    expect(result.current.loadingMore).toBe(false);
    expect(typeof result.current.showMore).toBe("function");
    // The base a chat-scoped expansion re-asks with is the one these rows were
    // ranked under, not one the surface rebuilt from the raw query.
    expect(result.current.expansionBase).toEqual(latestCall().base);
  });

  it("has no showMore when there is no next cursor", () => {
    useChatSearchResultsMock.mockReturnValue({
      kind: "ready",
      results: mergedResults({
        messageMatches: [messageMatch({ chatId: "c1" })],
        messageNextCursor: null,
      }),
      loadingMore: false,
      loadMoreError: null,
    });

    const { result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    if (result.current.kind !== "ready") {
      throw new Error("expected a ready status");
    }
    expect(result.current.showMore).toBeNull();
  });
});

describe("useChatSearchMessageHits: fixed request fields", () => {
  it("sends a ranked, unfiltered request with the trimmed query and the forwarded scope", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "idle" });

    renderMessageHits({
      hostId: "host-1",
      query: "  hello world  ",
      scope: VALID_SCOPE,
    });

    const base = latestCall().base;
    if (base === null) {
      throw new Error("expected a request to have been sent");
    }
    expect(base.mode).toBe("ranked");
    expect(base.tiers).toBeNull();
    expect(base.roleFilter).toBe("any");
    expect(base.dateRange).toBeNull();
    expect(base.harness).toBeNull();
    expect(base.query).toBe("hello world");
    expect(base.scope).toEqual(VALID_SCOPE);
  });
});

describe("useChatSearchMessageHits: paging", () => {
  it("resets the paging cursor when the host changes, even under an unchanged query", () => {
    useChatSearchResultsMock.mockReturnValue({
      kind: "ready",
      results: mergedResults({
        messageMatches: [messageMatch({ chatId: "c1" })],
        messageNextCursor: "cur-1",
      }),
      loadingMore: false,
      loadMoreError: null,
    });

    const { rerender, result } = renderMessageHits({
      hostId: "host-1",
      query: "hello world",
      scope: VALID_SCOPE,
    });

    act(() => {
      if (result.current.kind === "ready" && result.current.showMore !== null) {
        result.current.showMore();
      }
    });
    rerender({ hostId: "host-1", query: "hello world", scope: VALID_SCOPE });

    expect(latestCall().messageCursors).toEqual(["cur-1"]);

    rerender({ hostId: "host-2", query: "hello world", scope: VALID_SCOPE });

    expect(latestCall().messageCursors).toEqual([]);
  });
});
