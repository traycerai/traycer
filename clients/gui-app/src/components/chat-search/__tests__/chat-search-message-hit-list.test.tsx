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
    readonly expansionBase: ChatSearchBaseRequest;
    readonly showMore: (() => void) | null;
    readonly loadingMore: boolean;
    readonly loadMoreError: ChatSearchPageError | null;
  }>,
): ChatSearchMessageHitsStatus {
  return {
    kind: "ready",
    messages: input.messages ?? [],
    indexState: input.indexState ?? "complete",
    // A surface's `renderExpansion` reads it; the list itself uses it only as
    // the identity it remounts on.
    expansionBase: input.expansionBase ?? EXPANSION_BASE,
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
  readonly rerenderWith: (next: ChatSearchMessageHitsStatus) => void;
} {
  const onOpen = vi.fn<(target: ChatSearchOpenTarget) => void>();
  const renderExpansion = vi.fn<
    (target: ChatSearchExpansionTarget) => ReactNode
  >(() => null);
  // `status` sits after the spread: it is the one prop `rerenderWith` drives,
  // so an override may seed it but must not pin it.
  const element = (status: ChatSearchMessageHitsStatus) => (
    <ChatSearchMessageHitList
      onOpen={onOpen}
      renderExpansion={renderExpansion}
      taskTitles={new Map()}
      variant="full"
      {...overrides}
      status={status}
    />
  );
  const { container, rerender } = render(
    element(overrides.status ?? readyStatus({})),
  );
  return {
    container,
    onOpen,
    renderExpansion,
    // A surface mounts the list once and feeds it status after status, so a
    // new request must arrive as a rerender of the same element, never as a
    // fresh render.
    rerenderWith: (next) => rerender(element(next)),
  };
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

describe("ChatSearchMessageHitList: the best-hit child row", () => {
  it("keeps the snippet on one line in both variants and sizes the role column per variant", () => {
    const snippetText = "the quick brown fox jumps over the lazy dog";
    const match = messageMatch({
      chatId: "c1",
      best: messageHit({ messageId: "c1-m1", text: snippetText }),
    });

    renderList({
      status: readyStatus({ messages: [match] }),
      variant: "compact",
    });
    const compactRow = screen.getByRole("button", {
      name: new RegExp(`^Agent reply, .*: ${snippetText}$`),
    });
    const compactSnippet = compactRow.children.item(1);
    if (compactSnippet === null) {
      throw new Error("expected the row to have a snippet element");
    }
    expect(compactSnippet.className).toContain("truncate");
    expect(compactSnippet.className).not.toContain("line-clamp");
    expect(compactRow.children.item(0)?.className).toContain("w-[7ch]");
    cleanup();

    renderList({
      status: readyStatus({ messages: [match] }),
      variant: "full",
    });
    const fullRow = screen.getByRole("button", {
      name: new RegExp(`^Agent reply, .*: ${snippetText}$`),
    });
    const fullSnippet = fullRow.children.item(1);
    if (fullSnippet === null) {
      throw new Error("expected the row to have a snippet element");
    }
    expect(fullSnippet.className).toContain("truncate");
    expect(fullRow.children.item(0)?.className).toContain("w-[11ch]");
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

    await user.click(
      screen.getByRole("button", {
        name: "Open chat title-c1 at its best match",
      }),
    );

    expect(onOpen).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      messageId: "best-id",
    });
  });
});

describe("ChatSearchMessageHitList: show more", () => {
  it("renders 'Show more matches' and calls showMore when clicked", async () => {
    const user = userEvent.setup();
    const showMore = vi.fn<() => void>();
    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        showMore,
      }),
    });

    await user.click(screen.getByRole("button", { name: "Show more matches" }));
    expect(showMore).toHaveBeenCalledTimes(1);
  });

  it("hides 'Show more matches' when showMore is null", () => {
    renderList({
      status: readyStatus({
        messages: [messageMatch({ chatId: "c1" })],
        showMore: null,
      }),
    });

    expect(
      screen.queryByRole("button", { name: "Show more matches" }),
    ).toBeNull();
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
    expect(
      screen.queryByRole("button", { name: "Show more matches" }),
    ).toBeNull();
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

describe("ChatSearchMessageHitList: a new request", () => {
  it("collapses an expanded group when the next ready status is a different request", async () => {
    const user = userEvent.setup();
    const match = messageMatch({ chatId: "c1", matchCount: 4 });
    const { renderExpansion, rerenderWith } = renderList({
      status: readyStatus({ messages: [match] }),
    });

    await user.click(screen.getByRole("button", { name: "4 matches" }));
    expect(
      screen
        .getByRole("button", { name: "4 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    renderExpansion.mockClear();

    // The same chat still matches the new query, so the row and its toggle
    // survive the list's reconciliation - which is exactly how the expansion
    // used to carry over, along with every expansion page already loaded.
    rerenderWith(
      readyStatus({
        messages: [match],
        expansionBase: { ...EXPANSION_BASE, query: "another query" },
      }),
    );

    expect(
      screen
        .getByRole("button", { name: "4 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(renderExpansion).not.toHaveBeenCalled();
  });

  it("keeps an expanded group while the request is unchanged", async () => {
    const user = userEvent.setup();
    const match = messageMatch({ chatId: "c1", matchCount: 4 });
    const { rerenderWith } = renderList({
      status: readyStatus({ messages: [match] }),
    });

    await user.click(screen.getByRole("button", { name: "4 matches" }));
    // A later page of the same request: more rows, same expansionBase.
    rerenderWith(
      readyStatus({
        messages: [match, messageMatch({ chatId: "c2" })],
      }),
    );

    expect(
      screen
        .getByRole("button", { name: "4 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("ChatSearchMessageHitList: expansion", () => {
  it("shows an 'N matches' disclosure and expands via renderExpansion", async () => {
    const user = userEvent.setup();
    const match = messageMatch({ chatId: "c1", matchCount: 4 });
    const { renderExpansion } = renderList({
      status: readyStatus({ messages: [match] }),
    });

    const toggle = screen.getByRole("button", { name: "4 matches" });
    expect(renderExpansion).not.toHaveBeenCalled();

    await user.click(toggle);

    expect(renderExpansion).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "c1",
      best: match.best,
      matchCount: 4,
      expanded: true,
      variant: "full",
    });
  });
});
