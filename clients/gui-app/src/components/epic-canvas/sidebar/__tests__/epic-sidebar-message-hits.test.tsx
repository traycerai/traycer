/**
 * The Agents panel's "In messages" section: what it asks, when it is there at
 * all, and where a hit opens.
 *
 * `useChatSearchMessageHits` is mocked by its real signature rather than
 * driven: what it does with a query is its own suite's subject (the two-char
 * gate, the debounce, the host gate). What matters here is that this surface
 * hands it the PANEL's query, the TASK SESSION's host, and this task's scope -
 * and that a hit opens on that same host.
 */
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
} from "@traycer/protocol/host/chat-search/schemas";
import { EpicSidebarMessageHits } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits";
import {
  messageHitsTreeState,
  showsMessageHitsSection,
  useEpicSidebarMessageHits,
  type EpicSidebarMessageHitsState,
} from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { chatSearchEmptyStateDescription } from "@/components/epic-canvas/sidebar/epic-sidebar-panel-filters";
import type { SidebarBulkSelectionValue } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import type {
  useChatSearchMessageHits,
  ChatSearchMessageHitsStatus,
} from "@/hooks/chats/use-chat-search-message-hits";
import type {
  ChatSearchBaseRequest,
  ChatSearchExpansionStatus,
  useChatSearchMessageRows,
} from "@/hooks/chats/use-chat-search-query";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";
import {
  chatTranscriptJumpKey,
  useChatTranscriptJumpStore,
} from "@/stores/chats/chat-transcript-jump-store";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const SESSION_HOST_ID = "session-host";
const EFFECTIVE_HOST_ID = "effective-host";

const hitsMock = vi.hoisted(() => vi.fn<typeof useChatSearchMessageHits>());
vi.mock("@/hooks/chats/use-chat-search-message-hits", () => ({
  useChatSearchMessageHits: hitsMock,
}));

// The expansion's own request is the rows hook's subject; what matters here is
// the real ExpandedRows and rows drawn from whatever it answers.
const rowsMock = vi.hoisted(() => vi.fn<typeof useChatSearchMessageRows>());
vi.mock("@/hooks/chats/use-chat-search-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-chat-search-query")
  >()),
  useChatSearchMessageRows: rowsMock,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: (): string | null => SESSION_HOST_ID,
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
// Mutable: whether the app is pointed at the host serving this task decides
// who parks the transcript jump.
const effectiveHostId = vi.hoisted(() => ({ current: "" }));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: (): string | null => effectiveHostId.current,
}));

const navigateMock = vi.hoisted(() => vi.fn<(options: unknown) => void>());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const openResultMock = vi.hoisted(() =>
  vi.fn<typeof openChatSearchResult>(() => undefined),
);
vi.mock("@/lib/chat-search/open-chat-search-result", () => ({
  openChatSearchResult: openResultMock,
}));

// Selection mode is a context this suite has no provider for, and the rest of
// the module is real: `epic-sidebar-panel-filters` imports its tree filter.
const selection = vi.hoisted(() => ({
  current: null as SidebarBulkSelectionValue | null,
}));
vi.mock(
  "@/components/epic-canvas/sidebar/epic-sidebar-selection",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/sidebar/epic-sidebar-selection")
    >()),
    useMaybeSidebarBulkSelection: (): SidebarBulkSelectionValue | null =>
      selection.current,
  }),
);

const EXPANSION_BASE: ChatSearchBaseRequest = {
  query: "webview",
  scope: { kind: "current-task", epicId: EPIC_ID },
  tiers: null,
  roleFilter: "any",
  dateRange: null,
  harness: null,
  mode: "ranked",
};

function messageHit(messageId: string): ChatSearchMessageHit {
  return {
    messageId,
    tier: "assistant",
    createdAt: Date.now(),
    interAgent: false,
    truncated: false,
    snippet: { text: "the webview keeps a destroyed entry", highlights: [] },
  };
}

function messageMatch(
  chatId: string,
  matchCount: number,
): ChatSearchMessageMatch {
  return {
    epicId: EPIC_ID,
    ownerUserId: "user-1",
    chatId,
    title: `title-${chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    matchCount,
    best: messageHit(`${chatId}-m1`),
    messages: [],
  };
}

function readyStatus(
  messages: ReadonlyArray<ChatSearchMessageMatch>,
  showMore: (() => void) | null,
): ChatSearchMessageHitsStatus {
  return {
    kind: "ready",
    messages,
    indexState: "complete",
    expansionBase: EXPANSION_BASE,
    showMore,
    loadingMore: false,
    loadMoreError: null,
  };
}

/** The same answer from a host whose startup sweep has not finished. */
function partialReadyStatus(
  messages: ReadonlyArray<ChatSearchMessageMatch>,
): ChatSearchMessageHitsStatus {
  return {
    kind: "ready",
    messages,
    indexState: "partial",
    expansionBase: EXPANSION_BASE,
    showMore: null,
    loadingMore: false,
    loadMoreError: null,
  };
}

function sectionState(
  status: ChatSearchMessageHitsStatus,
): EpicSidebarMessageHitsState {
  return { status, query: " webview ", client: null, hostId: SESSION_HOST_ID };
}

function bulkSelection(selectionMode: boolean): SidebarBulkSelectionValue {
  return {
    panelId: "chats",
    selectionMode,
    selectedIds: new Set<string>(),
    selectableIds: [],
    selectedVisibleIds: [],
    selectedCount: 0,
    canSelect: true,
    allVisibleSelected: false,
    pendingDeleteIds: null,
    deletePending: false,
    enterSelectionMode: () => undefined,
    cancelSelection: () => undefined,
    toggleSelection: () => undefined,
    selectAllVisible: () => undefined,
    deselectAllVisible: () => undefined,
    setSelectableIds: () => undefined,
    requestDeleteSelected: () => undefined,
    closeDeleteDialog: () => undefined,
    setDeletePending: () => undefined,
    clearSelectedIds: () => undefined,
    armSelectablePruneExit: () => undefined,
    resetSelection: () => undefined,
  };
}

/**
 * The section with one multi-hit chat, on a named host - a NEW element each
 * call, which is what makes a `rerender` with it reach the subtree.
 */
function sectionOnHost(hostId: string) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <EpicSidebarMessageHits
        state={{
          status: readyStatus([messageMatch("c1", 3)], null),
          query: " webview ",
          client: null,
          hostId,
        }}
      />
    </QueryClientProvider>
  );
}

function renderHits(selectionMode: boolean) {
  selection.current = selectionMode ? bulkSelection(true) : null;
  return renderHook(() =>
    useEpicSidebarMessageHits({ epicId: EPIC_ID, tabId: TAB_ID }),
  );
}

function lastQueryAsked(): string {
  const calls = hitsMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].query;
}

function expansionHit(messageId: string, text: string): ChatSearchMessageHit {
  return { ...messageHit(messageId), snippet: { text, highlights: [] } };
}

type ReadyExpansion = Extract<
  ChatSearchExpansionStatus,
  { readonly kind: "ready" }
>;

function readyExpansion(overrides: Partial<ReadyExpansion>): ReadyExpansion {
  return {
    kind: "ready",
    messages: [
      expansionHit("c1-m2", "second snippet"),
      expansionHit("c1-m3", "third snippet"),
    ],
    matchCount: null,
    nextCursor: null,
    loadingMore: false,
    loadMoreError: null,
    ...overrides,
  };
}

/** Which control has focus, by the name a screen reader would read. */
function focusedName(): string {
  const active = document.activeElement;
  return active?.getAttribute("aria-label") ?? active?.textContent ?? "";
}

beforeEach(() => {
  hitsMock.mockReturnValue({ kind: "absent" });
  rowsMock.mockReturnValue({ kind: "loading" });
  effectiveHostId.current = EFFECTIVE_HOST_ID;
  usePanelHeaderSearchStore.getState().openSearch(TAB_ID, "chats", "webview");
  useChatSearchStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  hitsMock.mockReset();
  rowsMock.mockReset();
  navigateMock.mockReset();
  openResultMock.mockReset();
  usePanelHeaderSearchStore.getState().closeSearch(TAB_ID, "chats");
  useChatTranscriptJumpStore.setState({ requestsByChatId: {} });
});

describe("useEpicSidebarMessageHits: what it asks", () => {
  it("asks the session host about this task, with the panel's query", () => {
    renderHits(false);

    const call = hitsMock.mock.calls[hitsMock.mock.calls.length - 1][0];
    expect(call.query).toBe("webview");
    expect(call.hostId).toBe(SESSION_HOST_ID);
    expect(call.scope).toEqual({ kind: "current-task", epicId: EPIC_ID });
  });

  it("asks nothing while the search box is closed", () => {
    usePanelHeaderSearchStore.getState().closeSearch(TAB_ID, "chats");

    renderHits(false);

    expect(lastQueryAsked()).toBe("");
  });

  it("asks nothing while bulk selection owns the header", () => {
    renderHits(true);

    expect(lastQueryAsked()).toBe("");
  });
});

describe("messageHitsTreeState: what the tree is told", () => {
  it("reports an unasked search as absent, and draws no section", () => {
    expect(messageHitsTreeState({ kind: "absent" })).toBe("absent");
    expect(showsMessageHitsSection("absent")).toBe(false);
  });

  it("reports a settled, empty, exhausted answer as empty, and draws no section", () => {
    expect(messageHitsTreeState(readyStatus([], null))).toBe("empty");
    expect(showsMessageHitsSection("empty")).toBe(false);
  });

  it("keeps a section for an empty answer from a half-built index", () => {
    expect(messageHitsTreeState(partialReadyStatus([]))).toBe("indexing");
    expect(showsMessageHitsSection("indexing")).toBe(true);
  });

  it("keeps a section for an empty page that still has somewhere to page to", () => {
    const status = readyStatus([], () => undefined);

    expect(messageHitsTreeState(status)).toBe("hits");
    expect(showsMessageHitsSection("hits")).toBe(true);
  });

  it("keeps loading and error visible, and only the first suppresses an empty state", () => {
    expect(messageHitsTreeState({ kind: "loading" })).toBe("loading");
    expect(messageHitsTreeState({ kind: "error", message: "boom" })).toBe(
      "error",
    );
    expect(showsMessageHitsSection("loading")).toBe(true);
    expect(showsMessageHitsSection("error")).toBe(true);
  });
});

describe("EpicSidebarMessageHits", () => {
  it("heads the section with how many agents matched", () => {
    render(
      <EpicSidebarMessageHits
        state={sectionState(
          readyStatus([messageMatch("c1", 1), messageMatch("c2", 1)], null),
        )}
      />,
    );

    expect(screen.getByLabelText("In messages")).not.toBeNull();
    expect(screen.getByText("· 2 agents", { exact: false })).not.toBeNull();
  });

  it("opens a hit on the session host, with the effective host as context", async () => {
    const user = userEvent.setup();
    render(
      <EpicSidebarMessageHits
        state={sectionState(readyStatus([messageMatch("c1", 1)], null))}
      />,
    );

    await user.click(screen.getByText("title-c1"));

    expect(openResultMock).toHaveBeenCalledTimes(1);
    const [, target, context] = openResultMock.mock.calls[0];
    expect(target).toEqual({
      epicId: EPIC_ID,
      chatId: "c1",
      messageId: "c1-m1",
      hostId: SESSION_HOST_ID,
    });
    expect(context.effectiveHostId).toBe(EFFECTIVE_HOST_ID);
  });

  it("hands the trimmed query to the dialog, scoped to every task", async () => {
    const user = userEvent.setup();
    render(
      <EpicSidebarMessageHits
        state={sectionState(readyStatus([messageMatch("c1", 1)], null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: /All tasks/ }));

    const store = useChatSearchStore.getState();
    expect(store.open).toBe(true);
    expect(store.initialQuery).toBe("webview");
    expect(store.scope).toBe("all-accessible-tasks");
  });

  it("keeps the still-indexing caveat when a half-built index found nothing", () => {
    render(
      <EpicSidebarMessageHits state={sectionState(partialReadyStatus([]))} />,
    );

    expect(screen.getByLabelText("In messages")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Still indexing chats on this host. Some results may be missing.",
    );
    expect(screen.queryByText("· 0 agents", { exact: false })).toBeNull();
  });

  it("parks the jump on the searched host when the app is pointed elsewhere", async () => {
    const user = userEvent.setup();
    render(
      <EpicSidebarMessageHits
        state={sectionState(readyStatus([messageMatch("c1", 1)], null))}
      />,
    );

    await user.click(screen.getByText("title-c1"));

    // The route declines to park for a tile it may have to open fresh, because
    // from a notification that tile could be on any host. From here it is this
    // tab, on the session host - so the section parks it there itself, under a
    // key no tile on the effective host can read.
    const parked =
      useChatTranscriptJumpStore.getState().requestsByChatId[
        chatTranscriptJumpKey(SESSION_HOST_ID, "c1")
      ];
    expect(parked?.target).toEqual({ kind: "message", messageId: "c1-m1" });
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[
        chatTranscriptJumpKey(EFFECTIVE_HOST_ID, "c1")
      ],
    ).toBeUndefined();
  });

  it("leaves the jump to the route when the searched host is the effective one", async () => {
    effectiveHostId.current = SESSION_HOST_ID;
    const user = userEvent.setup();
    render(
      <EpicSidebarMessageHits
        state={sectionState(readyStatus([messageMatch("c1", 1)], null))}
      />,
    );

    await user.click(screen.getByText("title-c1"));

    expect(openResultMock).toHaveBeenCalledTimes(1);
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[
        chatTranscriptJumpKey(SESSION_HOST_ID, "c1")
      ],
    ).toBeUndefined();
  });

  it("keeps expansions across a rerender and drops them when the host changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(sectionOnHost(SESSION_HOST_ID));
    await user.click(screen.getByRole("button", { name: /^\d+ matches$/ }));
    expect(
      screen
        .getByRole("button", { name: /^\d+ matches$/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    // A fresh element every time: handing `rerender` the same object makes
    // React bail out of the subtree, and both halves of this would then pass
    // for that reason rather than for the key's.
    rerender(sectionOnHost(SESSION_HOST_ID));
    expect(
      screen
        .getByRole("button", { name: /^\d+ matches$/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    rerender(sectionOnHost("other-host"));
    expect(
      screen
        .getByRole("button", { name: /^\d+ matches$/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  // The sidebar mounts no arrow-key provider, so its expanded children are
  // ordinary Tab stops - the arrow-only `tabIndex={-1}` would strand them.
  describe("keyboard, with no arrow-key navigation", () => {
    async function expandGroup(user: UserEvent) {
      render(sectionOnHost(SESSION_HOST_ID));
      const toggle = screen.getByRole("button", { name: /^\d+ matches$/ });
      await user.click(toggle);
      toggle.focus();
      return toggle;
    }

    it("Tab and Enter reach an expanded child, and Tab and Space reach Show more", async () => {
      rowsMock.mockImplementation((args) =>
        readyExpansion({
          nextCursor: args.cursors.length === 0 ? "cursor-1" : null,
        }),
      );
      const user = userEvent.setup();
      await expandGroup(user);

      await user.tab();
      expect(focusedName()).toMatch(/: the webview keeps a destroyed entry$/);
      await user.tab();
      expect(focusedName()).toMatch(/: second snippet$/);

      await user.keyboard("{Enter}");
      expect(openResultMock).toHaveBeenCalledTimes(1);
      expect(openResultMock.mock.calls[0][1]).toEqual({
        epicId: EPIC_ID,
        chatId: "c1",
        messageId: "c1-m2",
        hostId: SESSION_HOST_ID,
      });

      await user.tab();
      expect(focusedName()).toMatch(/: third snippet$/);
      await user.tab();
      expect(focusedName()).toBe("Show more matches");

      await user.keyboard(" ");
      const calls = rowsMock.mock.calls;
      expect(calls[calls.length - 1][0].cursors).toEqual(["cursor-1"]);
    });

    it("Tab and Enter reach Retry after a later page failed", async () => {
      const retry = vi.fn<() => void>();
      rowsMock.mockReturnValue(
        readyExpansion({ loadMoreError: { message: "Page failed", retry } }),
      );
      const user = userEvent.setup();
      await expandGroup(user);

      // Best, second, third, then the retry button.
      await user.tab();
      await user.tab();
      await user.tab();
      await user.tab();
      expect(focusedName()).toBe("Retry");

      await user.keyboard("{Enter}");
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });

  it("reports an error in the section rather than on the tree", () => {
    render(
      <EpicSidebarMessageHits
        state={sectionState({ kind: "error", message: "Host went away" })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("Host went away");
  });
});

describe("chatSearchEmptyStateDescription", () => {
  it("says nothing when the messages were never settled and no filter is on", () => {
    expect(chatSearchEmptyStateDescription(false, false)).toBeNull();
  });

  it("adds the messages once their search has come back empty", () => {
    expect(chatSearchEmptyStateDescription(false, true)).toBe(
      "…and no messages match.",
    );
  });

  it("keeps the filter caveat alongside it", () => {
    expect(chatSearchEmptyStateDescription(true, true)).toBe(
      "…and no messages match. The current filters may also be hiding matches.",
    );
  });
});
