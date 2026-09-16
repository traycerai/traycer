import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_SEARCH_MAX_QUERY_CHARS } from "@traycer/protocol/host/chat-search/schemas";
import type { ChatSearchChatMatch } from "@traycer/protocol/host/chat-search/schemas";
import { ChatSearchPanel } from "@/components/chat-search/chat-search-panel";
import type { ChatSearchBaseRequest } from "@/hooks/chats/use-chat-search-query";
import type { ChatSearchMergedResults } from "@/lib/chat-search/chat-search-results";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const effectiveHostId = vi.hoisted(() => ({
  current: "host-1" as string | null,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => effectiveHostId.current,
}));

const hostClientMock = vi.hoisted(() => ({}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClientMock,
}));

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

const useChatSearchResultsMock = vi.hoisted(() => vi.fn());
const useChatSearchMessageRowsMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/chats/use-chat-search-query", () => ({
  useChatSearchResults: (
    args: Parameters<typeof useChatSearchResultsMock>[0],
  ) => useChatSearchResultsMock(args),
  useChatSearchMessageRows: (
    args: Parameters<typeof useChatSearchMessageRowsMock>[0],
  ) => useChatSearchMessageRowsMock(args),
}));

vi.mock("@/hooks/chats/use-chat-search-task-titles", () => ({
  useChatSearchTaskTitles: () => new Map<string, string>(),
}));

vi.mock("@/hooks/ui/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/stores/epics/canvas/canvas-selectors", () => ({
  useActiveEpicId: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: () => null,
}));

function idleStatus() {
  return { kind: "idle" as const };
}

function chatMatch(input: {
  readonly chatId: string;
  readonly title?: string;
  readonly messageMatchCount?: number;
}): ChatSearchChatMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: input.chatId,
    title: input.title ?? `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    titleHighlights: [],
    messageMatchCount: input.messageMatchCount ?? 0,
  };
}

function results(
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

function latestBase(): ChatSearchBaseRequest | null {
  const calls = useChatSearchResultsMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1] as [
    { base: ChatSearchBaseRequest | null },
  ];
  return lastCall[0].base;
}

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

afterEach(() => {
  cleanup();
  navigateMock.mockReset();
  useChatSearchResultsMock.mockReset();
  useChatSearchMessageRowsMock.mockReset();
  effectiveHostId.current = "host-1";
  setReachable(true);
});

describe("ChatSearchPanel: host reachability", () => {
  it("sends no request while the host is unreachable, then sends one once it connects", async () => {
    useChatSearchResultsMock.mockReturnValue(idleStatus());
    setReachable(false);

    const user = userEvent.setup();
    const { rerender } = render(<ChatSearchPanel onClose={vi.fn()} />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "hello",
    );

    expect(latestBase()).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Waiting for the host to connect…");
    expect(screen.queryByRole("alert")).toBeNull();

    setReachable(true);
    rerender(<ChatSearchPanel onClose={vi.fn()} />);

    const base = latestBase();
    expect(base).not.toBeNull();
    expect(base?.query).toBe("hello");
  });
});

describe("ChatSearchPanel: query cap", () => {
  it("caps the request query at CHAT_SEARCH_MAX_QUERY_CHARS", () => {
    useChatSearchResultsMock.mockReturnValue(idleStatus());

    render(<ChatSearchPanel onClose={vi.fn()} />);

    const input = screen.getByRole("searchbox", { name: "Search chats" });
    expect(input.getAttribute("maxlength")).toBe(
      String(CHAT_SEARCH_MAX_QUERY_CHARS),
    );

    const overLong = "a".repeat(CHAT_SEARCH_MAX_QUERY_CHARS + 88);
    fireEvent.change(input, { target: { value: overLong } });

    const base = latestBase();
    expect(base).not.toBeNull();
    expect(base?.query.length).toBeLessThanOrEqual(CHAT_SEARCH_MAX_QUERY_CHARS);
  });
});

describe("ChatSearchPanel: results view keyed by request", () => {
  it("collapses a group's expansion again once the query changes", async () => {
    useChatSearchResultsMock.mockReturnValue({
      kind: "ready",
      results: results({
        chatMatches: [chatMatch({ chatId: "c1", messageMatchCount: 3 })],
      }),
      loadingMore: false,
      loadMoreError: null,
    });
    useChatSearchMessageRowsMock.mockReturnValue({
      kind: "ready",
      messages: [],
      nextCursor: null,
      loadingMore: false,
    });

    const user = userEvent.setup();
    render(<ChatSearchPanel onClose={vi.fn()} />);

    const toggle = screen.getByRole("button", {
      name: "also 3 matches in messages",
    });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const input = screen.getByRole("searchbox", { name: "Search chats" });
    await user.type(input, "changed");

    const collapsedToggle = screen.getByRole("button", {
      name: "also 3 matches in messages",
    });
    expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
  });
});
