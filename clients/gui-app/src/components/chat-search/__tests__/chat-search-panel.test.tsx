import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_SEARCH_MAX_QUERY_CHARS } from "@traycer/protocol/host/chat-search/schemas";
import type {
  ChatSearchChatMatch,
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
} from "@traycer/protocol/host/chat-search/schemas";
import { ChatSearchPanel } from "@/components/chat-search/chat-search-panel";
import type {
  ChatSearchBaseRequest,
  useChatSearchMessageRows,
  useChatSearchResults,
} from "@/hooks/chats/use-chat-search-query";
import type { ChatSearchMergedResults } from "@/lib/chat-search/chat-search-results";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";

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

const useChatSearchResultsMock = vi.hoisted(() =>
  vi.fn<typeof useChatSearchResults>(),
);
const useChatSearchMessageRowsMock = vi.hoisted(() =>
  vi.fn<typeof useChatSearchMessageRows>(),
);
vi.mock("@/hooks/chats/use-chat-search-query", () => ({
  useChatSearchResults: useChatSearchResultsMock,
  useChatSearchMessageRows: useChatSearchMessageRowsMock,
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

const openResultMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/chat-search/open-chat-search-result", () => ({
  openChatSearchResult: openResultMock,
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

function messageMatch(input: {
  readonly chatId: string;
  readonly matchCount: number;
}): ChatSearchMessageMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: input.chatId,
    title: `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    matchCount: input.matchCount,
    best: {
      messageId: `${input.chatId}-m1`,
      tier: "assistant",
      createdAt: Date.now(),
      interAgent: false,
      truncated: false,
      snippet: { text: "snippet text", highlights: [] },
    },
    messages: [],
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
  openResultMock.mockReset();
  useChatSearchStore.getState().resetForTests();
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
    // The count line is always mounted, so this is one of two statuses.
    const status = screen.getByText("Waiting for the host to connect…");
    expect(status.getAttribute("role")).toBe("status");
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
      loadMoreError: null,
    });

    const user = userEvent.setup();
    render(<ChatSearchPanel onClose={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: "3 matches" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const input = screen.getByRole("searchbox", { name: "Search chats" });
    await user.type(input, "changed");

    const collapsedToggle = screen.getByRole("button", { name: "3 matches" });
    expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("ChatSearchPanel: count line and filter vocabulary", () => {
  function countLine(): HTMLElement {
    // Always mounted, so it exists before there is anything to count.
    const line = screen
      .getAllByRole("status")
      .find((element) => element.classList.contains("tabular-nums"));
    if (line === undefined) throw new Error("expected the count line");
    return line;
  }

  it("is mounted and empty before a search has run", () => {
    useChatSearchResultsMock.mockReturnValue(idleStatus());

    render(<ChatSearchPanel onClose={vi.fn()} />);

    expect(countLine().textContent).toBe("");
  });

  it("says the search is running while it loads", () => {
    useChatSearchResultsMock.mockReturnValue({ kind: "loading" });

    render(<ChatSearchPanel onClose={vi.fn()} />);

    expect(countLine().textContent).toBe("Searching chats…");
  });

  it("counts both sections, with a plus on the one that has more pages", () => {
    useChatSearchResultsMock.mockReturnValue({
      kind: "ready",
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" }), chatMatch({ chatId: "c2" })],
        chatNextCursor: null,
        messageMatches: [messageMatch({ chatId: "c3", matchCount: 1 })],
        messageNextCursor: "next",
      }),
      loadingMore: false,
      loadMoreError: null,
    });

    render(<ChatSearchPanel onClose={vi.fn()} />);

    expect(countLine().textContent).toBe(
      "2 chats by title · 1+ chats with message matches",
    );
  });

  it("labels the message filter with the same role words the rows use", () => {
    useChatSearchResultsMock.mockReturnValue(idleStatus());
    useChatSearchStore.getState().setRoleFilter("human");
    const { unmount } = render(<ChatSearchPanel onClose={vi.fn()} />);
    expect(
      screen.getByRole("combobox", { name: "Message filter" }).textContent,
    ).toBe("You");
    unmount();

    useChatSearchStore.getState().setRoleFilter("assistant");
    render(<ChatSearchPanel onClose={vi.fn()} />);
    expect(
      screen.getByRole("combobox", { name: "Message filter" }).textContent,
    ).toBe("Agent reply");
  });
});

// The real ExpandedRows and results view under the real panel: only the two
// host queries are faked, so the collapse, count and keyboard rules below are
// the shipped ones rather than a mock's.
describe("ChatSearchPanel: an expanded message hit", () => {
  const SEP_8 = new Date(2026, 8, 8, 12).getTime();

  function hit(messageId: string, text: string): ChatSearchMessageHit {
    return {
      messageId,
      tier: "assistant",
      createdAt: SEP_8,
      interAgent: false,
      truncated: false,
      snippet: { text, highlights: [] },
    };
  }

  function match(
    chatId: string,
    matchCount: number,
    best: ChatSearchMessageHit,
  ): ChatSearchMessageMatch {
    return {
      epicId: "epic-1",
      ownerUserId: "user-1",
      chatId,
      title: `title-${chatId}`,
      lifecycleState: "active",
      updatedAt: SEP_8,
      matchCount,
      best,
      messages: [],
    };
  }

  function showMessageMatches(
    matches: ReadonlyArray<ChatSearchMessageMatch>,
  ): void {
    useChatSearchResultsMock.mockReturnValue({
      kind: "ready",
      results: results({ messageMatches: matches }),
      loadingMore: false,
      loadMoreError: null,
    });
  }

  /** Serves `pages` one per cursor, the way the host pages a chat's hits. */
  function servePages(
    pages: ReadonlyArray<ReadonlyArray<ChatSearchMessageHit>>,
  ) {
    useChatSearchMessageRowsMock.mockImplementation((args) => {
      const loaded = args.cursors.length;
      return {
        kind: "ready",
        messages: pages.slice(0, loaded + 1).flat(),
        nextCursor: loaded < pages.length - 1 ? `cursor-${loaded + 1}` : null,
        loadingMore: false,
        loadMoreError: null,
      };
    });
  }

  /** Renders the panel with a real query typed, which the expansion needs. */
  function renderSearching(onClose: () => void) {
    const view = render(<ChatSearchPanel onClose={onClose} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "needle" },
    });
    return view;
  }

  function caption(): string {
    const node = screen.getByText(/^Showing \d+ snippets?/);
    return String(node.textContent);
  }

  it("keeps 25 distinct snippets at 25 as each page loads", async () => {
    const hits = Array.from({ length: 25 }, (_, index) =>
      hit(`m${index}`, `distinct snippet number ${index}`),
    );
    showMessageMatches([match("c1", 25, hits[0])]);
    servePages([hits.slice(0, 10), hits.slice(10, 20), hits.slice(20)]);
    const user = userEvent.setup();
    renderSearching(vi.fn());
    // Nothing is asked of the host until the group is opened.
    expect(useChatSearchMessageRowsMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "25 matches" }));
    expect(caption()).toBe("Showing 10 snippets · 10 of 25 matches");

    await user.click(screen.getByRole("button", { name: "Show more matches" }));
    expect(caption()).toBe("Showing 20 snippets · 20 of 25 matches");

    await user.click(screen.getByRole("button", { name: "Show more matches" }));
    expect(caption()).toBe("Showing 25 snippets · 25 of 25 matches");
    expect(screen.queryByLabelText(/^Repeated/)).toBeNull();
    // Best is one of the 25, printed once; the other 24 follow it.
    expect(screen.getAllByText(/^distinct snippet number/)).toHaveLength(25);
    // Out of pages: no continuation left.
    expect(
      screen.queryByRole("button", { name: "Show more matches" }),
    ).toBeNull();
  });

  it("collapses 13 identical snippets to one row marked x13, opening the best message", async () => {
    const same = "the webview keeps a destroyed entry";
    const hits = Array.from({ length: 13 }, (_, index) =>
      hit(`m${index}`, same),
    );
    showMessageMatches([match("c1", 13, hits[0])]);
    // Best is served back by its own page; it must not be counted twice.
    servePages([hits]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSearching(onClose);

    // Collapsed: best is a real row, once, with no count before the answer.
    expect(screen.getAllByText(same)).toHaveLength(1);
    expect(screen.queryByLabelText(/^Repeated/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "13 matches" }));

    expect(screen.getAllByText(same)).toHaveLength(1);
    expect(screen.getByLabelText("Repeated 13 times").textContent).toBe("×13");
    expect(caption()).toBe("Showing 1 snippet · 13 of 13 matches");
    const row = screen.getByRole("button", {
      name: `Agent reply, Sep 8, repeated 13 times: ${same}`,
    });

    await user.click(row);

    expect(openResultMock).toHaveBeenCalledTimes(1);
    expect(openResultMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        hostId: "host-1",
        epicId: "epic-1",
        chatId: "c1",
        messageId: "m0",
      },
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps best first and printed once when the host serves it after other hits", async () => {
    const best = hit("best", "best words");
    const other = hit("other", "other words");
    showMessageMatches([match("c1", 2, best)]);
    servePages([[other, best]]);
    const user = userEvent.setup();
    renderSearching(vi.fn());

    await user.click(screen.getByRole("button", { name: "2 matches" }));

    expect(screen.getAllByText("best words")).toHaveLength(1);
    const rows = screen
      .getAllByRole("button", { name: /^Agent reply/ })
      .map((row) => row.getAttribute("aria-label"));
    expect(rows).toEqual([
      "Agent reply, Sep 8: best words",
      "Agent reply, Sep 8: other words",
    ]);
    expect(caption()).toBe("Showing 2 snippets · 2 of 2 matches");
  });

  describe("keyboard", () => {
    function setUp() {
      const first = hit("a", "alpha words");
      const second = hit("b", "beta words");
      showMessageMatches([
        match("c1", 3, first),
        match("c2", 1, hit("z", "zeta words")),
      ]);
      servePages([[first, second], [hit("c", "gamma words")]]);
    }

    function focusedName(): string {
      const active = document.activeElement;
      return active?.getAttribute("aria-label") ?? active?.textContent ?? "";
    }

    it("Tab skips the expanded children and Show more, while the arrows reach them", async () => {
      setUp();
      const user = userEvent.setup();
      renderSearching(vi.fn());
      const disclosure = screen.getByRole("button", { name: "3 matches" });
      await user.click(disclosure);
      expect(
        screen.getByRole("button", { name: "Show more matches" }),
      ).toBeTruthy();

      disclosure.focus();
      await user.tab();
      // Straight to the next chat's header: three child rows and the
      // continuation sit between them and are not tab stops.
      expect(focusedName()).toBe("Open chat title-c2 at its best match");

      disclosure.focus();
      const walked: string[] = [];
      for (let step = 0; step < 5; step += 1) {
        await user.keyboard("{ArrowDown}");
        walked.push(focusedName());
      }
      expect(walked).toEqual([
        "Agent reply, Sep 8: alpha words",
        "Agent reply, Sep 8: beta words",
        "Show more matches",
        "Open chat title-c2 at its best match",
        "Agent reply, Sep 8: zeta words",
      ]);
      // And back up through them.
      await user.keyboard("{ArrowUp}");
      expect(focusedName()).toBe("Open chat title-c2 at its best match");
    });

    it("skips the hidden retained children once the group collapses, but keeps best", async () => {
      setUp();
      const user = userEvent.setup();
      const { container } = renderSearching(vi.fn());
      const disclosure = screen.getByRole("button", { name: "3 matches" });
      await user.click(disclosure);
      await user.click(disclosure);
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      // The tail stays mounted for the closing transition, inert and disabled.
      expect(container.querySelector("[inert]")).not.toBeNull();
      const tail = screen.getByRole("button", {
        name: "Agent reply, Sep 8: beta words",
      });
      expect(tail.hasAttribute("disabled")).toBe(true);
      expect(
        screen
          .getByRole("button", { name: "Show more matches" })
          .hasAttribute("disabled"),
      ).toBe(true);

      disclosure.focus();
      await user.keyboard("{ArrowDown}");
      expect(focusedName()).toBe("Agent reply, Sep 8: alpha words");
      await user.keyboard("{ArrowDown}");
      expect(focusedName()).toBe("Open chat title-c2 at its best match");
    });

    it("ArrowRight and ArrowLeft on a header open and close it without moving focus", async () => {
      setUp();
      const user = userEvent.setup();
      renderSearching(vi.fn());
      const header = screen.getByRole("button", {
        name: "Open chat title-c1 at its best match",
      });
      const disclosure = screen.getByRole("button", { name: "3 matches" });
      header.focus();

      await user.keyboard("{ArrowRight}");
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(header);
      expect(screen.getByText(/^Showing \d+ snippets?/)).toBeTruthy();

      await user.keyboard("{ArrowRight}");
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");

      await user.keyboard("{ArrowLeft}");
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(header);
    });
  });
});
