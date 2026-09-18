import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  ChatSearchMessageHitList,
  type ChatSearchMessageHitListProps,
} from "@/components/chat-search/chat-search-message-hit-list";
import type {
  ChatSearchExpansionTarget,
  ChatSearchOpenTarget,
} from "@/components/chat-search/chat-search-results-view";
import type { ChatSearchMessageHitsStatus } from "@/hooks/chats/use-chat-search-message-hits";
import type {
  ChatSearchBaseRequest,
  ChatSearchPageError,
} from "@/hooks/chats/use-chat-search-query";

vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: () => null,
}));

afterEach(() => {
  cleanup();
});

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
  readonly matchCount?: number;
  readonly best?: ChatSearchMessageHit;
}): ChatSearchMessageMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: input.chatId,
    title: `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    matchCount: input.matchCount ?? 1,
    best: input.best ?? messageHit({ messageId: `${input.chatId}-m1` }),
    messages: [],
  };
}

function readyStatus(
  input: Partial<{
    readonly messages: ReadonlyArray<ChatSearchMessageMatch>;
    readonly indexState: "complete" | "partial";
    readonly showMore: (() => void) | null;
    readonly loadingMore: boolean;
    readonly loadMoreError: ChatSearchPageError | null;
  }>,
): ChatSearchMessageHitsStatus {
  return {
    kind: "ready",
    messages: input.messages ?? [],
    indexState: input.indexState ?? "complete",
    // The list never reads it; a surface's `renderExpansion` does.
    expansionBase: EXPANSION_BASE,
    showMore: input.showMore ?? null,
    loadingMore: input.loadingMore ?? false,
    loadMoreError: input.loadMoreError ?? null,
  };
}

const EXPANSION_BASE: ChatSearchBaseRequest = {
  query: "snippet",
  scope: { kind: "current-task", epicId: "epic-1" },
  tiers: null,
  roleFilter: "any",
  dateRange: null,
  harness: null,
  mode: "ranked",
};

function renderList(overrides: Partial<ChatSearchMessageHitListProps>): {
  readonly container: HTMLElement;
  readonly onOpen: Mock<(target: ChatSearchOpenTarget) => void>;
  readonly renderExpansion: Mock<
    (target: ChatSearchExpansionTarget) => ReactNode
  >;
} {
  const onOpen = vi.fn<(target: ChatSearchOpenTarget) => void>();
  const renderExpansion = vi.fn<
    (target: ChatSearchExpansionTarget) => ReactNode
  >(() => null);
  const { container } = render(
    <ChatSearchMessageHitList
      status={readyStatus({})}
      onOpen={onOpen}
      renderExpansion={renderExpansion}
      taskTitles={new Map()}
      variant="full"
      {...overrides}
    />,
  );
  return { container, onOpen, renderExpansion };
}

describe("ChatSearchMessageHitList: non-ready statuses render nothing", () => {
  it("renders nothing for kind 'absent'", () => {
    const { container } = renderList({ status: { kind: "absent" } });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for kind 'loading'", () => {
    const { container } = renderList({ status: { kind: "loading" } });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for kind 'error'", () => {
    const { container } = renderList({
      status: { kind: "error", message: "boom" },
    });
    expect(container.firstChild).toBeNull();
  });
});

describe("ChatSearchMessageHitList: variant differences", () => {
  it("shows the task label in variant 'full'", () => {
    renderList({
      status: readyStatus({ messages: [messageMatch({ chatId: "c1" })] }),
      taskTitles: new Map([["epic-1", "My Task"]]),
      variant: "full",
    });

    expect(screen.getByText("My Task")).toBeTruthy();
  });

  it("hides the task label in variant 'compact'", () => {
    renderList({
      status: readyStatus({ messages: [messageMatch({ chatId: "c1" })] }),
      taskTitles: new Map([["epic-1", "My Task"]]),
      variant: "compact",
    });

    expect(screen.queryByText("My Task")).toBeNull();
  });
});

describe("ChatSearchMessageHitList: snippet clamping", () => {
  it("clamps the compact snippet to one line and the full snippet to two", () => {
    // The row's accessible name concatenates the title, snippet and meta
    // text with no separator, so the snippet element is found positionally
    // (the button's second direct child) rather than by its own text, which
    // an unstyled inner span sharing the same textContent would also match.
    const snippetText = "the quick brown fox jumps over the lazy dog";
    const match = messageMatch({
      chatId: "c1",
      best: messageHit({ messageId: "c1-m1", text: snippetText }),
    });

    renderList({
      status: readyStatus({ messages: [match] }),
      variant: "compact",
    });
    const compactRow = screen.getByRole("button", { name: /title-c1/ });
    const compactSnippet = compactRow.children.item(1);
    if (compactSnippet === null) {
      throw new Error("expected the row to have a snippet element");
    }
    expect(compactSnippet.className).toContain("line-clamp-1");
    cleanup();

    renderList({
      status: readyStatus({ messages: [match] }),
      variant: "full",
    });
    const fullRow = screen.getByRole("button", { name: /title-c1/ });
    const fullSnippet = fullRow.children.item(1);
    if (fullSnippet === null) {
      throw new Error("expected the row to have a snippet element");
    }
    expect(fullSnippet.className).toContain("line-clamp-2");
  });
});

describe("ChatSearchMessageHitList: opening a row", () => {
  it("calls onOpen with the row's epicId, chatId and best messageId", async () => {
    const user = userEvent.setup();
    const best = messageHit({ messageId: "best-id" });
    const match = messageMatch({ chatId: "c1", best });
    const { onOpen } = renderList({
      status: readyStatus({ messages: [match] }),
    });

    await user.click(screen.getByRole("button", { name: /title-c1/ }));

    expect(onOpen).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      messageId: "best-id",
    });
  });
});

describe("ChatSearchMessageHitList: show more", () => {
  it("renders 'Show more' and calls showMore when clicked", async () => {
    const user = userEvent.setup();
    const showMore = vi.fn<() => void>();
    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        showMore,
      }),
    });

    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(showMore).toHaveBeenCalledTimes(1);
  });

  it("hides 'Show more' when showMore is null", () => {
    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        showMore: null,
      }),
    });

    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("ChatSearchMessageHitList: a show-more page that failed", () => {
  it("shows the failure in place of the continuation, and retries it", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => void>();
    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        loadMoreError: { message: "Host went away", retry },
      }),
    });

    expect(screen.getByRole("alert").textContent).toBe("Host went away");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("ChatSearchMessageHitList: indexing notice", () => {
  it("shows the 'Still indexing' status only when indexState is 'partial'", () => {
    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        indexState: "partial",
      }),
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Still indexing chats on this host",
    );
    cleanup();

    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        indexState: "complete",
      }),
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ChatSearchMessageHitList: expansion", () => {
  it("shows a 'Show all N matches' toggle and expands via renderExpansion", async () => {
    const user = userEvent.setup();
    const match = messageMatch({ chatId: "c1", matchCount: 4 });
    const { renderExpansion } = renderList({
      status: readyStatus({ messages: [match] }),
    });

    const toggle = screen.getByRole("button", { name: "Show all 4 matches" });
    expect(renderExpansion).not.toHaveBeenCalled();

    await user.click(toggle);

    expect(renderExpansion).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
    });
  });
});
