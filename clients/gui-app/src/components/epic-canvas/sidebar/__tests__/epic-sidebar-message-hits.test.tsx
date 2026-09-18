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
import { userEvent } from "@testing-library/user-event";
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
import type { ChatSearchBaseRequest } from "@/hooks/chats/use-chat-search-query";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const SESSION_HOST_ID = "session-host";
const EFFECTIVE_HOST_ID = "effective-host";

const hitsMock = vi.hoisted(() => vi.fn<typeof useChatSearchMessageHits>());
vi.mock("@/hooks/chats/use-chat-search-message-hits", () => ({
  useChatSearchMessageHits: hitsMock,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: (): string | null => SESSION_HOST_ID,
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: (): string | null => EFFECTIVE_HOST_ID,
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

function messageMatch(chatId: string): ChatSearchMessageMatch {
  return {
    epicId: EPIC_ID,
    ownerUserId: "user-1",
    chatId,
    title: `title-${chatId}`,
    lifecycleState: "active",
    updatedAt: Date.now(),
    matchCount: 1,
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

beforeEach(() => {
  hitsMock.mockReturnValue({ kind: "absent" });
  usePanelHeaderSearchStore.getState().openSearch(TAB_ID, "chats", "webview");
  useChatSearchStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  hitsMock.mockReset();
  navigateMock.mockReset();
  openResultMock.mockReset();
  usePanelHeaderSearchStore.getState().closeSearch(TAB_ID, "chats");
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
          readyStatus([messageMatch("c1"), messageMatch("c2")], null),
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
        state={sectionState(readyStatus([messageMatch("c1")], null))}
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
        state={sectionState(readyStatus([messageMatch("c1")], null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: /All tasks/ }));

    const store = useChatSearchStore.getState();
    expect(store.open).toBe(true);
    expect(store.initialQuery).toBe("webview");
    expect(store.scope).toBe("all-accessible-tasks");
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
