import type { ComponentProps, ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  ChatSearchChatMatch,
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  ChatSearchResultsView,
  type ChatSearchExpansionTarget,
  type ChatSearchOpenTarget,
} from "@/components/chat-search/chat-search-results-view";
import type { ChatSearchMergedResults } from "@/lib/chat-search/chat-search-results";

const registeredTitles = vi.hoisted(() => new Map<string, string>());

// The live registered title of a task open in this window. Faked at the
// selector: registering a real open-epic handle means booting an epic store.
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: (epicId: string | null) =>
    epicId === null ? null : (registeredTitles.get(epicId) ?? null),
}));

afterEach(() => {
  cleanup();
  registeredTitles.clear();
});

function chatMatch(input: {
  readonly chatId: string;
  readonly title?: string;
  readonly titleHighlights?: ChatSearchChatMatch["titleHighlights"];
  readonly messageMatchCount?: number;
}): ChatSearchChatMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: input.chatId,
    title: input.title ?? `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    titleHighlights: input.titleHighlights ?? [],
    messageMatchCount: input.messageMatchCount ?? 0,
  };
}

function messageHit(input: {
  readonly messageId: string;
  readonly text?: string;
}): ChatSearchMessageHit {
  return {
    messageId: input.messageId,
    tier: "assistant",
    createdAt: Date.now(),
    interAgent: false,
    truncated: false,
    snippet: { text: input.text ?? "snippet text", highlights: [] },
  };
}

function messageMatch(input: {
  readonly chatId: string;
  readonly title?: string;
  readonly matchCount?: number;
  readonly best?: ChatSearchMessageHit;
}): ChatSearchMessageMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: input.chatId,
    title: input.title ?? `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    matchCount: input.matchCount ?? 1,
    best: input.best ?? messageHit({ messageId: `${input.chatId}-m1` }),
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

function renderView(
  overrides: Partial<ComponentProps<typeof ChatSearchResultsView>>,
): {
  readonly onOpen: Mock<(target: ChatSearchOpenTarget) => void>;
  readonly onShowMoreChats: Mock<(cursor: string) => void>;
  readonly onShowMoreMessages: Mock<(cursor: string) => void>;
  readonly renderExpansion: Mock<
    (target: ChatSearchExpansionTarget) => ReactNode
  >;
} {
  const onOpen = vi.fn<(target: ChatSearchOpenTarget) => void>();
  const onShowMoreChats = vi.fn<(cursor: string) => void>();
  const onShowMoreMessages = vi.fn<(cursor: string) => void>();
  const renderExpansion = vi.fn<
    (target: ChatSearchExpansionTarget) => ReactNode
  >(() => null);
  render(
    <ChatSearchResultsView
      results={results({})}
      loadingMore={false}
      loadMoreError={null}
      messagesSearched
      onOpen={onOpen}
      onShowMoreChats={onShowMoreChats}
      onShowMoreMessages={onShowMoreMessages}
      renderExpansion={renderExpansion}
      taskTitles={new Map()}
      {...overrides}
    />,
  );
  return { onOpen, onShowMoreChats, onShowMoreMessages, renderExpansion };
}

describe("ChatSearchResultsView: sections", () => {
  it("renders a Chats heading followed by a message-matches separator, chats first", () => {
    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        messageMatches: [messageMatch({ chatId: "c2" })],
      }),
    });

    const heading = screen.getByRole("heading", { name: "Chats" });
    const separator = screen.getByRole("separator", {
      name: "Matches in messages",
    });
    // The separator (and everything under it) must follow the Chats section
    // in document order.
    expect(
      heading.compareDocumentPosition(separator) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const titleRow = screen.getByRole("button", { name: /title-c1/ });
    const messageRow = screen.getByRole("button", { name: /title-c2/ });
    expect(
      titleRow.compareDocumentPosition(messageRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator.compareDocumentPosition(messageRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders no separator when there are no message matches", () => {
    renderView({
      results: results({ chatMatches: [chatMatch({ chatId: "c1" })] }),
    });

    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("shows 'No chats match.' when both sections are empty", () => {
    renderView({ results: results({}) });

    expect(screen.getByText("No chats match.")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Chats" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("ChatSearchResultsView: highlighting", () => {
  it("renders title highlights as <mark> around the matched substring", () => {
    renderView({
      results: results({
        chatMatches: [
          chatMatch({
            chatId: "c1",
            title: "hello world",
            titleHighlights: [{ start: 0, end: 5 }],
          }),
        ],
      }),
    });

    // The row's accessible name concatenates node text with no inserted
    // space at element boundaries, so match on the row itself (the only
    // button in this render) rather than the full spaced string.
    const row = screen.getByRole("button");
    const mark = within(row).getByText("hello", { selector: "mark" });
    expect(mark.tagName).toBe("MARK");
    expect(row.textContent).toContain("hello world");
  });
});

describe("ChatSearchResultsView: expansion", () => {
  it("shows an 'N matches' disclosure on a title match that expands on click", async () => {
    const user = userEvent.setup();
    const { renderExpansion } = renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1", messageMatchCount: 6 })],
      }),
    });

    const toggle = screen.getByRole("button", { name: "6 matches" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(renderExpansion).not.toHaveBeenCalled();

    await user.click(toggle);

    expect(renderExpansion).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      best: null,
      matchCount: 6,
      expanded: true,
      variant: "full",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders renderExpansion's output once expanded", async () => {
    const user = userEvent.setup();
    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1", messageMatchCount: 2 })],
      }),
      renderExpansion: () => <div data-testid="expansion-output">rows</div>,
    });

    expect(screen.queryByTestId("expansion-output")).toBeNull();
    await user.click(screen.getByRole("button", { name: "2 matches" }));
    expect(screen.getByTestId("expansion-output")).not.toBeNull();
  });

  it("says '1 match' and offers no disclosure for a title match without message matches", () => {
    renderView({
      results: results({
        chatMatches: [
          chatMatch({ chatId: "c1", messageMatchCount: 1 }),
          chatMatch({ chatId: "c2", messageMatchCount: 0 }),
        ],
      }),
    });

    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "1 match" })).toBeTruthy();
  });
});

describe("ChatSearchResultsView: a message-hit row", () => {
  const best = {
    ...messageHit({ messageId: "best-id", text: "the needle is here" }),
    createdAt: new Date(2026, 8, 8, 12).getTime(),
  };

  it("draws the chat as a header, a sibling disclosure and the best hit once", () => {
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 13, best })],
      }),
      taskTitles: new Map([["epic-1", "My Task"]]),
    });

    const header = screen.getByRole("button", {
      name: "Open chat title-c1 at its best match",
    });
    const disclosure = screen.getByRole("button", { name: "13 matches" });
    expect(header.contains(disclosure)).toBe(false);
    expect(header.textContent).toContain("title-c1");
    expect(header.textContent).toContain("My Task");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    const controlled = disclosure.getAttribute("aria-controls");
    expect(controlled).not.toBeNull();
    const region = document.getElementById(controlled ?? "");
    expect(region).not.toBeNull();
    // The best hit is a real child row, present exactly once, with no ×N until
    // the expansion has answered.
    expect(screen.getAllByText("the needle is here")).toHaveLength(1);
    expect(region?.textContent).not.toContain("×");
    expect(
      screen.getByRole("button", {
        name: "Agent reply, Sep 8: the needle is here",
      }),
    ).toBeTruthy();
  });

  it("offers no disclosure for a chat with a single match", () => {
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 1 })],
      }),
    });

    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.queryByRole("button", { name: /matches?$/ })).toBeNull();
  });

  it("opens the chat at the best hit from the header and from the child row", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 3, best })],
      }),
    });

    await user.click(
      screen.getByRole("button", {
        name: "Open chat title-c1 at its best match",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: /^Agent reply, Sep 8:/ }),
    );

    expect(onOpen.mock.calls).toEqual([
      [{ epicId: "epic-1", chatId: "c1", messageId: "best-id" }],
      [{ epicId: "epic-1", chatId: "c1", messageId: "best-id" }],
    ]);
  });

  it("does not ask for the expansion until the disclosure opens, then passes the best hit and count", async () => {
    const user = userEvent.setup();
    const { renderExpansion } = renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 25, best })],
      }),
    });
    expect(renderExpansion).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "25 matches" }));

    expect(renderExpansion).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      best,
      matchCount: 25,
      expanded: true,
      variant: "full",
    });
  });

  it("keeps the expansion mounted, flagged collapsed, so it can close smoothly", async () => {
    const user = userEvent.setup();
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 4, best })],
      }),
      renderExpansion: (target) => (
        <div data-testid="expansion" data-expanded={String(target.expanded)} />
      ),
    });
    const disclosure = screen.getByRole("button", { name: "4 matches" });

    await user.click(disclosure);
    expect(screen.getByTestId("expansion").getAttribute("data-expanded")).toBe(
      "true",
    );
    await user.click(disclosure);

    expect(screen.getByTestId("expansion").getAttribute("data-expanded")).toBe(
      "false",
    );
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it("ArrowRight and ArrowLeft on the header expand and collapse without moving focus", async () => {
    const user = userEvent.setup();
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 4, best })],
      }),
    });
    const header = screen.getByRole("button", {
      name: "Open chat title-c1 at its best match",
    });
    const disclosure = screen.getByRole("button", { name: "4 matches" });
    header.focus();

    await user.keyboard("{ArrowRight}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(header);

    // Right again is idempotent: the row stays open.
    await user.keyboard("{ArrowRight}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{ArrowLeft}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(header);

    await user.keyboard("{ArrowLeft}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it("ArrowRight and ArrowLeft on the disclosure itself set the state too", async () => {
    const user = userEvent.setup();
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 4, best })],
      }),
    });
    const disclosure = screen.getByRole("button", { name: "4 matches" });
    disclosure.focus();

    await user.keyboard("{ArrowRight}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(disclosure);
  });

  it("leaves Left and Right alone on a chat with nothing to expand", async () => {
    const user = userEvent.setup();
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1", matchCount: 1, best })],
      }),
    });
    screen
      .getByRole("button", { name: "Open chat title-c1 at its best match" })
      .focus();

    await user.keyboard("{ArrowRight}");

    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
  });

  it("uses the generic 'Show more matches' label for the message continuation", () => {
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1" })],
        messageNextCursor: "cursor-messages",
      }),
    });

    expect(
      screen.getByRole("button", { name: "Show more matches" }),
    ).toBeTruthy();
  });
});

describe("ChatSearchResultsView: opening rows", () => {
  it("calls onOpen with messageId: null when a title row is clicked", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderView({
      results: results({ chatMatches: [chatMatch({ chatId: "c1" })] }),
    });

    await user.click(screen.getByRole("button", { name: /title-c1/ }));

    expect(onOpen).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      messageId: null,
    });
  });

  it("calls onOpen with the best hit's messageId when a message row is clicked", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderView({
      results: results({
        messageMatches: [
          messageMatch({
            chatId: "c1",
            best: messageHit({ messageId: "best-message-id" }),
          }),
        ],
      }),
    });

    await user.click(screen.getByRole("button", { name: /title-c1/ }));

    expect(onOpen).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      messageId: "best-message-id",
    });
  });
});

describe("ChatSearchResultsView: show more", () => {
  it("calls onShowMoreChats with the cursor, and hides the button when the cursor is null", async () => {
    const user = userEvent.setup();
    const { onShowMoreChats } = renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        chatNextCursor: "cursor-chats",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Show more chats" }));
    expect(onShowMoreChats).toHaveBeenCalledWith("cursor-chats");
  });

  it("hides 'Show more chats' when chatNextCursor is null", () => {
    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        chatNextCursor: null,
      }),
    });

    expect(
      screen.queryByRole("button", { name: "Show more chats" }),
    ).toBeNull();
  });

  it("calls onShowMoreMessages with the cursor, and hides the button when the cursor is null", async () => {
    const user = userEvent.setup();
    const { onShowMoreMessages } = renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1" })],
        messageNextCursor: "cursor-messages",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Show more matches" }));
    expect(onShowMoreMessages).toHaveBeenCalledWith("cursor-messages");
  });

  it("hides 'Show more matches' when messageNextCursor is null", () => {
    renderView({
      results: results({
        messageMatches: [messageMatch({ chatId: "c1" })],
        messageNextCursor: null,
      }),
    });

    expect(
      screen.queryByRole("button", { name: "Show more matches" }),
    ).toBeNull();
  });
});

describe("ChatSearchResultsView: a show-more page that failed", () => {
  it("keeps the loaded chat rows, shows the failure in place of the continuation, and retries that page", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => void>();
    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        // The failed page is the last one, so it contributes no cursor.
        chatNextCursor: null,
      }),
      loadMoreError: { section: "chats", message: "Host went away", retry },
    });

    expect(screen.getByText("title-c1")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Host went away");
    expect(
      screen.queryByRole("button", { name: "Show more chats" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("reports a failed message page under the message section and leaves the chat section alone", () => {
    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        chatNextCursor: "cursor-chats",
        messageMatches: [messageMatch({ chatId: "c2" })],
        messageNextCursor: null,
      }),
      loadMoreError: {
        section: "messages",
        message: "Host went away",
        retry: () => {},
      },
    });

    expect(
      screen.getByRole("button", { name: "Show more chats" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "Matches in messages" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Host went away");
  });
});

describe("ChatSearchResultsView: indexing notice", () => {
  it("shows the 'Still indexing' status only when indexState is partial", () => {
    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        indexState: "partial",
      }),
    });
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Still indexing chats on this host");
    cleanup();

    renderView({
      results: results({
        chatMatches: [chatMatch({ chatId: "c1" })],
        indexState: "complete",
      }),
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ChatSearchResultsView: task names", () => {
  it("names a result's task from the task list when the task is not open in this window", () => {
    renderView({
      results: results({
        chatMatches: [
          { ...chatMatch({ chatId: "c1" }), epicId: "epic-closed" },
        ],
        messageMatches: [
          { ...messageMatch({ chatId: "c2" }), epicId: "epic-closed" },
        ],
      }),
      taskTitles: new Map([["epic-closed", "Closed task title"]]),
    });

    expect(screen.getAllByText("Closed task title")).toHaveLength(2);
  });

  it("prefers the registered title of a task open in this window over the task list", () => {
    registeredTitles.set("epic-open", "Live open title");
    renderView({
      results: results({
        chatMatches: [{ ...chatMatch({ chatId: "c1" }), epicId: "epic-open" }],
      }),
      taskTitles: new Map([["epic-open", "Stale listed title"]]),
    });

    expect(screen.getByText("Live open title")).toBeTruthy();
    expect(screen.queryByText("Stale listed title")).toBeNull();
  });

  it("renders no task name when neither source has the task", () => {
    renderView({
      results: results({
        chatMatches: [
          { ...chatMatch({ chatId: "c1" }), epicId: "epic-unknown" },
        ],
      }),
      taskTitles: new Map([["epic-other", "Other task"]]),
    });

    expect(screen.queryByText("Other task")).toBeNull();
    const row = screen.getByRole("button", { name: /title-c1/ });
    expect(row.textContent).not.toContain("epic-unknown");
  });
});

describe("ChatSearchResultsView: an empty page that still has a cursor", () => {
  // Access is resolved after ranking and paging, so a page whose matches all
  // belonged to unreadable tasks arrives empty with its cursor intact.
  it("keeps the chats continuation reachable when the page came back empty", async () => {
    const { onShowMoreChats } = renderView({
      results: results({ chatMatches: [], chatNextCursor: "20" }),
    });

    expect(screen.getByText("No matches on this page.")).toBeTruthy();
    expect(screen.queryByText("No chats match.")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Show more chats" }),
    );

    expect(onShowMoreChats.mock.calls).toEqual([["20"]]);
  });

  it("keeps the message-matches continuation reachable when that page came back empty", async () => {
    const { onShowMoreMessages } = renderView({
      results: results({ messageMatches: [], messageNextCursor: "20" }),
    });

    expect(
      screen.getByRole("separator", { name: "Matches in messages" }),
    ).toBeTruthy();
    expect(screen.getByText("No matches on this page.")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Show more matches" }),
    );

    expect(onShowMoreMessages.mock.calls).toEqual([["20"]]);
  });

  it("reports the terminal state only once both sections are out of pages", () => {
    renderView({
      results: results({
        chatMatches: [],
        chatNextCursor: null,
        messageMatches: [],
        messageNextCursor: null,
      }),
    });

    expect(screen.getByText("No chats match.")).toBeTruthy();
    expect(screen.queryByText("No matches on this page.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });
});
