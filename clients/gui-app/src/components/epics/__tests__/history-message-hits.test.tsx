/**
 * History's message-hit section, on its own: the gates that decide whether it
 * is there at all, the header's honesty about host and filters, and the two
 * ways out of it (opening a hit, handing the query to the dialog).
 *
 * Mounted directly rather than through `<EpicsListPanel>` - the panel's own
 * suite carries the mount, the selection gate and the arrow traversal, which
 * are the parts that need the real list around them.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
  ChatSearchResponse,
} from "@traycer/protocol/host/chat-search/schemas";
import { HistoryMessageHits } from "@/components/epics/history-message-hits";
import type {
  ChatSearchMessageHitsStatus,
  ChatSearchSurfaceScope,
} from "@/hooks/chats/use-chat-search-message-hits";
import type { ChatSearchBaseRequest } from "@/hooks/chats/use-chat-search-query";
import type { ChatSearchResultTarget } from "@/lib/chat-search/open-chat-search-result";
import type { NotificationNavigate } from "@/lib/notifications";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";

const testState = vi.hoisted(() => ({
  hostPresent: true,
  hostId: "host-test" as string | null,
  hostEntry: null as HostDirectoryEntry | null,
  directoryCalls: 0,
  status: { kind: "absent" } as ChatSearchMessageHitsStatus,
  historyOverlayActive: false,
  hitsArgs: [] as Array<{
    readonly hostId: string | null;
    readonly query: string;
    readonly scopeKind: string;
  }>,
  navigate: vi.fn(),
  close: vi.fn<() => void>(),
  openResult: vi.fn<
    (
      navigate: NotificationNavigate,
      target: ChatSearchResultTarget,
      context: {
        readonly effectiveHostId: string | null;
        readonly now: number;
      },
    ) => void
  >(),
}));

// The section's own gate: a host runtime above it, or nothing to ask. The
// client is opaque here - the search hook that would use it is mocked.
const stubHostClient = { getActiveHostId: () => "host-test" };
vi.mock("@/lib/host", () => ({
  useOptionalHostClient: () => (testState.hostPresent ? stubHostClient : null),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => testState.hostId,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => {
    testState.directoryCalls += 1;
    return testState.hostEntry;
  },
}));
vi.mock("@/hooks/chats/use-chat-search-message-hits", () => ({
  useChatSearchMessageHits: (args: {
    readonly client: unknown;
    readonly hostId: string | null;
    readonly query: string;
    readonly scope: ChatSearchSurfaceScope | null;
  }): ChatSearchMessageHitsStatus => {
    testState.hitsArgs.push({
      hostId: args.hostId,
      query: args.query,
      scopeKind: args.scope === null ? "none" : args.scope.kind,
    });
    return testState.status;
  },
}));
vi.mock("@/hooks/chats/use-chat-search-task-titles", () => ({
  useChatSearchTaskTitles: () => new Map([["epic-1", "Listed task"]]),
}));
// Expanding a group renders this, and the real one issues a chat-scoped query
// that needs a QueryClient and a live host. The section's contract with it is
// which chat it is handed, so that is what the stand-in reports.
vi.mock("@/components/chat-search/chat-search-expanded-rows", () => ({
  ChatSearchExpandedRows: (props: {
    readonly client: unknown;
    readonly base: ChatSearchBaseRequest;
    readonly epicId: string;
    readonly chatId: string;
    readonly onOpenMessage: (messageId: string) => void;
  }) => <div data-testid={`expanded-${props.chatId}`} />,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: () => null,
}));
vi.mock("@/lib/chat-search/open-chat-search-result", () => ({
  openChatSearchResult: (
    navigate: NotificationNavigate,
    target: ChatSearchResultTarget,
    context: {
      readonly effectiveHostId: string | null;
      readonly now: number;
    },
  ): void => {
    testState.openResult(navigate, target, context);
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemOverlayActive: () => testState.historyOverlayActive,
  useSystemTabModalActions: () => ({
    openSettings: () => {},
    openHistory: () => {},
    close: testState.close,
    setSection: () => {},
  }),
}));

function messageHit(messageId: string): ChatSearchMessageHit {
  return {
    messageId,
    tier: "assistant",
    createdAt: 1_700_000_000_000,
    interAgent: false,
    truncated: false,
    snippet: {
      text: "the browser guest keeps a destroyed entry",
      highlights: [],
    },
  };
}

function messageMatch(
  chatId: string,
  // More than one match is what earns the row its expand toggle, which is the
  // only place this list keeps state a stale key could carry over.
  matchCount: number,
): ChatSearchMessageMatch {
  return {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId,
    title: `Chat ${chatId}`,
    lifecycleState: "active",
    updatedAt: 1_700_000_000_000,
    matchCount,
    best: messageHit(`${chatId}-m1`),
    messages: [],
  };
}

const EXPANSION_BASE: ChatSearchBaseRequest = {
  query: "browser",
  scope: { kind: "all-accessible-tasks" },
  tiers: null,
  roleFilter: "any",
  dateRange: null,
  harness: null,
  mode: "ranked",
};

function readyStatus(
  messages: ReadonlyArray<ChatSearchMessageMatch>,
  indexState: ChatSearchResponse["indexState"],
): Extract<ChatSearchMessageHitsStatus, { readonly kind: "ready" }> {
  return {
    kind: "ready",
    messages,
    indexState,
    expansionBase: EXPANSION_BASE,
    showMore: null,
    loadingMore: false,
    loadMoreError: null,
  };
}

/** The partial-index caveat: the one status that is not the header's count. */
function stillIndexingNote(): HTMLElement {
  const note = screen.getByText(/Still indexing/);
  expect(note.getAttribute("role")).toBe("status");
  return note;
}

function renderSection(overrides: {
  readonly query?: string;
  readonly filtersActive?: boolean;
  readonly taskListSettled?: boolean;
  readonly display?: "list" | "count-only";
  readonly standalone?: boolean;
}): {
  readonly container: HTMLElement;
  readonly onRowKeyDown: () => void;
  readonly onCountChange: (count: string | null) => void;
  readonly onShowTasks: () => void;
  /** Re-renders the same props, so a changed `testState` is picked up. */
  readonly rerender: () => void;
} {
  const onRowKeyDown = vi.fn<() => void>();
  const onCountChange = vi.fn<(count: string | null) => void>();
  const onShowTasks = vi.fn<() => void>();
  // A FRESH element each time, not one held in a variable: React bails out of
  // a subtree whose element is reference-identical to the last render's, so
  // re-rendering the same object would do nothing at all and every assertion
  // after it would pass vacuously.
  const element = () => (
    <HistoryMessageHits
      query={overrides.query ?? "browser"}
      filtersActive={overrides.filtersActive ?? false}
      taskListSettled={overrides.taskListSettled ?? true}
      onRowKeyDown={onRowKeyDown}
      display={overrides.display ?? "list"}
      standalone={overrides.standalone ?? false}
      onCountChange={onCountChange}
      onShowTasks={onShowTasks}
    />
  );
  const view = render(element());
  return {
    container: view.container,
    onRowKeyDown,
    onCountChange,
    onShowTasks,
    rerender: () => {
      view.rerender(element());
    },
  };
}

beforeEach(() => {
  testState.hostPresent = true;
  testState.hostId = "host-test";
  testState.hostEntry = null;
  testState.directoryCalls = 0;
  testState.status = { kind: "absent" };
  testState.historyOverlayActive = false;
  testState.hitsArgs = [];
  testState.navigate.mockReset();
  testState.close.mockReset();
  testState.openResult.mockReset();
  useChatSearchStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
});

describe("HistoryMessageHits: when the question cannot be asked", () => {
  it("renders nothing, and asks nothing, below the body-search minimum", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { container } = renderSection({ query: " b " });

    expect(container.firstChild).toBeNull();
    // Not merely hidden: the search hook is never mounted, so no request is
    // built for a query the host would refuse anyway.
    expect(testState.hitsArgs).toEqual([]);
  });

  it("renders nothing with no host runtime above it", () => {
    testState.hostPresent = false;
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { container } = renderSection({});

    expect(container.firstChild).toBeNull();
    expect(testState.hitsArgs).toEqual([]);
  });

  it("renders nothing for an absent status", () => {
    const { container } = renderSection({});

    expect(container.firstChild).toBeNull();
  });

  it("searches every accessible task on the effective host", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({ query: "browser" });

    expect(testState.hitsArgs[0]).toEqual({
      hostId: "host-test",
      query: "browser",
      scopeKind: "all-accessible-tasks",
    });
  });
});

describe("HistoryMessageHits: the header", () => {
  it("names the host the index belongs to", () => {
    testState.hostEntry = {
      hostId: "host-test",
      label: "Tanveer's MacBook",
      kind: "local",
      websocketUrl: null,
      version: null,
      transportDialability: "dialable",
    };
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({});

    expect(screen.getByRole("heading").textContent).toBe("Message matches");
    expect(screen.getByRole("status").parentElement?.textContent).toBe(
      "1 chat on Tanveer's MacBook",
    );
  });

  it("falls back to this machine when the directory has no label", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({});

    expect(screen.getByRole("status").parentElement?.textContent).toBe(
      "1 chat on this machine",
    );
  });

  it("says filters narrow tasks only, and only while a task filter is active", () => {
    testState.status = readyStatus(
      [messageMatch("chat-1", 1), messageMatch("chat-2", 1)],
      "complete",
    );
    const sentence =
      "History filters narrow tasks only. These matches come from this machine’s whole chat index.";

    renderSection({ filtersActive: false });
    expect(screen.queryByText(sentence)).toBeNull();
    // The old "· not filtered" suffix is gone for good, not merely hidden.
    expect(screen.getByRole("heading").textContent).toBe("Message matches");
    expect(document.body.textContent).not.toContain("not filtered");
    cleanup();

    renderSection({ filtersActive: true });
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(document.body.textContent).not.toContain("not filtered");
  });

  it("hands off to chat search with the plain 'Refine in chat search' label", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({});

    expect(
      screen.getByRole("button", { name: "Refine in chat search" }),
    ).toBeTruthy();
  });
});

describe("HistoryMessageHits: the count line", () => {
  it("is an always-mounted status that says the search is running while it loads", () => {
    testState.status = { kind: "loading" };

    renderSection({});

    expect(screen.getByRole("status").textContent).toBe("Searching");
  });

  it("adds a plus when more pages of chats remain", () => {
    testState.status = {
      ...readyStatus(
        [messageMatch("chat-1", 1), messageMatch("chat-2", 1)],
        "complete",
      ),
      showMore: () => {},
    };

    renderSection({});

    expect(screen.getByRole("status").textContent).toBe("2+ chats");
  });
});

describe("HistoryMessageHits: the count it reports upward", () => {
  it("reports a primitive N once ready", () => {
    testState.status = readyStatus(
      [messageMatch("chat-1", 1), messageMatch("chat-2", 1)],
      "complete",
    );

    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith("2");
  });

  it("reports N+ while a next cursor exists", () => {
    testState.status = {
      ...readyStatus([messageMatch("chat-1", 1)], "complete"),
      showMore: () => {},
    };

    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith("1+");
  });

  it("reports 'pending' while the search is in flight", () => {
    testState.status = { kind: "loading" };

    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith("pending");
  });

  it("reports nothing for a failed search, never a false zero", () => {
    testState.status = { kind: "error", message: "The host went away." };

    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith(null);
    expect(onCountChange).not.toHaveBeenCalledWith("0");
  });

  it("reports nothing for an absent status", () => {
    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith(null);
  });

  it("reports nothing below the body-search minimum", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { onCountChange } = renderSection({ query: "b" });

    expect(onCountChange).toHaveBeenLastCalledWith(null);
    expect(testState.hitsArgs).toEqual([]);
  });

  it("reports nothing with no host client to ask", () => {
    testState.hostPresent = false;
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith(null);
  });

  it("reports a real zero when a ready search found nothing", () => {
    testState.status = readyStatus([], "complete");

    const { onCountChange } = renderSection({});

    expect(onCountChange).toHaveBeenLastCalledWith("0");
  });

  it("does not report again when a re-render leaves the projection unchanged", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { onCountChange, rerender } = renderSection({});
    rerender();
    rerender();

    expect(onCountChange).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryMessageHits: count-only display", () => {
  it("draws nothing but still asks, so the Tasks badge stays live", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { container, onCountChange } = renderSection({
      display: "count-only",
    });

    expect(container.firstChild).toBeNull();
    expect(testState.hitsArgs[0]?.scopeKind).toBe("all-accessible-tasks");
    expect(onCountChange).toHaveBeenLastCalledWith("1");
  });

  it("draws nothing even in standalone form", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    const { container } = renderSection({
      display: "count-only",
      standalone: true,
    });

    expect(container.firstChild).toBeNull();
  });
});

describe("HistoryMessageHits: the standalone Messages pane", () => {
  it("explains the two-character minimum and offers the way back to Tasks", () => {
    const { onShowTasks } = renderSection({ query: "b", standalone: true });

    expect(
      screen.getByText("Type 2 characters to search messages"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(onShowTasks).toHaveBeenCalledTimes(1);
    expect(testState.hitsArgs).toEqual([]);
  });

  it("gives an empty query the same explanation", () => {
    renderSection({ query: "", standalone: true });

    expect(
      screen.getByText("Type 2 characters to search messages"),
    ).toBeTruthy();
  });

  it("says search is unavailable on this machine, and never reads the host directory, with no host runtime", () => {
    testState.hostPresent = false;
    testState.hostEntry = {
      hostId: "host-test",
      label: "Tanveer's MacBook",
      kind: "local",
      websocketUrl: null,
      version: null,
      transportDialability: "dialable",
    };

    renderSection({ standalone: true });

    expect(
      screen.getByText("Message search isn’t available on this machine"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show tasks" })).toBeTruthy();
    // Outside a runtime provider the directory hook throws, so the cheap gate
    // must not reach for it at all.
    expect(testState.directoryCalls).toBe(0);
  });

  it("names the host when a runtime is present but the search source is absent", () => {
    testState.hostEntry = {
      hostId: "host-test",
      label: "Tanveer's MacBook",
      kind: "local",
      websocketUrl: null,
      version: null,
      transportDialability: "dialable",
    };

    renderSection({ standalone: true });

    expect(
      screen.getByText("Message search isn’t available on Tanveer's MacBook"),
    ).toBeTruthy();
  });

  it("says search is unavailable for an absent status", () => {
    renderSection({ standalone: true });

    expect(
      screen.getByText("Message search isn’t available on this machine"),
    ).toBeTruthy();
  });

  it("shows the loading section even before the task list has settled", () => {
    testState.status = { kind: "loading" };

    renderSection({ standalone: true, taskListSettled: false });

    expect(screen.getByTestId("history-message-hits-loading")).toBeTruthy();
  });

  it("renders the hits themselves", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({ standalone: true });

    expect(screen.getByRole("button", { name: /Chat chat-1/ })).toBeTruthy();
  });

  it("stays silent, not explanatory, when it is only the group under All", () => {
    const { container } = renderSection({ query: "b", standalone: false });

    expect(container.firstChild).toBeNull();
  });
});

describe("HistoryMessageHits: loading and failure", () => {
  it("withholds the loading row until the task list has settled", () => {
    testState.status = { kind: "loading" };

    const { container } = renderSection({ taskListSettled: false });

    expect(container.firstChild).toBeNull();
  });

  it("shows the loading row once the task list has settled", () => {
    testState.status = { kind: "loading" };

    renderSection({ taskListSettled: true });

    expect(
      screen.getByRole("heading", { name: "Message matches" }),
    ).toBeTruthy();
    expect(screen.getByTestId("history-message-hits-loading")).toBeTruthy();
  });

  it("states a failed search in place of the rows", () => {
    testState.status = { kind: "error", message: "The host went away." };

    renderSection({});

    expect(screen.getByRole("alert").textContent).toBe("The host went away.");
  });

  it("says so when the search found nothing", () => {
    testState.status = readyStatus([], "complete");

    renderSection({});

    expect(screen.getByText("No messages match.")).toBeTruthy();
    // A complete index means the empty answer is the whole answer; there is
    // no caveat to add, and adding one would imply doubt that does not exist.
    // (The header's count line is always a status, so look for the caveat.)
    expect(screen.queryByText(/Still indexing/)).toBeNull();
  });

  // The regression: an unfinished startup sweep is the likeliest EXPLANATION
  // for an empty result, and this branch returns before the shared list that
  // renders the note - so the one case that needs the caveat most was the one
  // case that lost it.
  it("keeps the still-indexing caveat on an empty result from a partial index", () => {
    testState.status = readyStatus([], "partial");

    renderSection({});

    expect(stillIndexingNote().textContent).toBe(
      "Still indexing chats on this host. Some results may be missing.",
    );
    expect(screen.getByText("No messages match.")).toBeTruthy();
  });

  it("keeps the caveat on a partial index that DID find something", () => {
    // The other half of the pair, so the note cannot regress to only ever
    // appearing on the empty branch: here the shared list draws it.
    testState.status = readyStatus([messageMatch("chat-1", 1)], "partial");

    renderSection({});

    expect(stillIndexingNote().textContent).toBe(
      "Still indexing chats on this host. Some results may be missing.",
    );
    expect(screen.queryByText("No messages match.")).toBeNull();
  });
});

describe("HistoryMessageHits: the two ways out", () => {
  it("opens a hit on the host that answered the search", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({});
    fireEvent.click(screen.getByRole("button", { name: /Chat chat-1/ }));

    expect(testState.openResult).toHaveBeenCalledTimes(1);
    const [, target, context] = testState.openResult.mock.calls[0];
    expect(target).toEqual({
      hostId: "host-test",
      epicId: "epic-1",
      chatId: "chat-1",
      messageId: "chat-1-m1",
    });
    expect(context.effectiveHostId).toBe("host-test");
  });

  it("dismisses the History overlay when a hit opens from the modal form", () => {
    testState.historyOverlayActive = true;
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({});
    fireEvent.click(screen.getByRole("button", { name: /Chat chat-1/ }));

    expect(testState.close).toHaveBeenCalledTimes(1);
  });

  it("leaves the overlay alone when History is a tab", () => {
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({});
    fireEvent.click(screen.getByRole("button", { name: /Chat chat-1/ }));

    expect(testState.close).not.toHaveBeenCalled();
  });

  it("hands the trimmed query to the dialog, scoped to every task", () => {
    testState.historyOverlayActive = true;
    testState.status = readyStatus([messageMatch("chat-1", 1)], "complete");

    renderSection({ query: "  browser  " });
    fireEvent.click(
      screen.getByRole("button", { name: "Refine in chat search" }),
    );

    const state = useChatSearchStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialQuery).toBe("browser");
    expect(state.scope).toBe("all-accessible-tasks");
    expect(testState.close).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryMessageHits: keyboard", () => {
  it("binds History's traversal to every hit control", () => {
    // Header, "N matches" disclosure and the best-hit child: three stops.
    testState.status = readyStatus([messageMatch("chat-1", 3)], "complete");

    const { container, onRowKeyDown } = renderSection({});
    const stops = container.querySelectorAll("[data-chat-search-nav]");
    // The marker the traversal reads is the chat-search one, placed by the
    // shared row - History's hook matches both. See
    // `use-history-list-keyboard-nav.ts`.
    expect(stops.length).toBe(3);
    for (const stop of stops) fireEvent.keyDown(stop, { key: "ArrowDown" });

    expect(onRowKeyDown).toHaveBeenCalledTimes(3);
  });

  it("lets Left and Right on a header expand and collapse instead of reaching History's traversal", () => {
    testState.status = readyStatus([messageMatch("chat-1", 3)], "complete");

    const { onRowKeyDown } = renderSection({});
    const header = screen.getByRole("button", {
      name: "Open chat Chat chat-1 at its best match",
    });
    fireEvent.keyDown(header, { key: "ArrowRight" });

    expect(
      screen
        .getByRole("button", { name: "3 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });
});

describe("HistoryMessageHits: a host switch is a different index", () => {
  it("drops the expansion when the effective host changes under one query", () => {
    // The list keys itself by the REQUEST, and the request carries no host, so
    // an unchanged query across a host switch is byte-identical. Without the
    // host in the key the expanded group and the page cursors under it would
    // survive onto rows from another machine's index, where those cursors and
    // that chat id mean nothing.
    testState.status = readyStatus([messageMatch("chat-1", 2)], "complete");

    const { rerender } = renderSection({});
    const toggle = screen.getByRole("button", { name: "2 matches" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(
      screen
        .getByRole("button", { name: "2 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    testState.hostId = "host-other";
    rerender();

    expect(
      screen
        .getByRole("button", { name: "2 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps the expansion when nothing about the request moved", () => {
    // The other side of the key, so it cannot regress into remounting on every
    // render and silently collapsing a group the reader just opened.
    testState.status = readyStatus([messageMatch("chat-1", 2)], "complete");

    const { rerender } = renderSection({});
    fireEvent.click(screen.getByRole("button", { name: "2 matches" }));
    rerender();

    expect(
      screen
        .getByRole("button", { name: "2 matches" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
