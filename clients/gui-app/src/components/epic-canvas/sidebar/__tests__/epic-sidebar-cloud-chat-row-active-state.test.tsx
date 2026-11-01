import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  EpicSidebarCloudChatRow,
  type CloudChatRowExpansion,
} from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import type { UnifiedCloudChatEntry } from "@/lib/chats/unified-chat-list";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";

/**
 * The row's active-state wiring, verified against the REAL canvas store.
 *
 * The sibling suite (`epic-sidebar-cloud-chat-row.test.tsx`) mocks the canvas
 * store module wholesale - load-bearing for its click-routing assertions, but
 * it means its active-state cases answer through hand-rolled selector fakes
 * that re-implement the comparison. This file mocks NOTHING from the canvas
 * store: it opens real tile refs in a real epic tab through the store's own
 * actions and asserts the row's highlight through the real
 * `useIsActiveEpicArtifact` / `useIsActiveTile` selectors - including the
 * record-backed gate that makes a published copy visible only through its
 * composite tile id.
 */

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

const reachability: { status: HostReachabilityStatus; hostLabel: string } = {
  status: "reachable",
  hostLabel: "Tanveer's laptop",
};

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => reachability,
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) =>
      prepare(),
}));

/** A leaf row: no subagents beneath it, so no expansion state to consult. */
const NO_CHILDREN: readonly UnifiedCloudChatEntry[] = [];
const LEAF_EXPANSION: CloudChatRowExpansion = {
  expandedIds: new Set<string>(),
  toggleExpanded: () => undefined,
};

const CHAT: CloudChatSummary = {
  identity: {
    taskId: "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7",
    chatId: "56254cae-aa80-4d06-914c-5086cdd65e3c",
    ownerUserId: "user-1",
  },
  ownerHostId: "host-b",
  createdAt: 100,
  visibility: "task",
  title: "Walkthrough",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 300,
  headSha256: null,
  publishedAt: 300,
  throughRecordSeq: null,
  isOwnedByViewer: true,
};

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  reachability.status = "reachable";
});

const rowClient = new QueryClient();

function rowTree(tabId: string, chat: CloudChatSummary): ReactNode {
  return (
    <QueryClientProvider client={rowClient}>
      <EpicSidebarCloudChatRow
        chat={chat}
        childEntries={NO_CHILDREN}
        expansion={LEAF_EXPANSION}
        tabId={tabId}
        depth={0}
        selectionMode={false}
      />
    </QueryClientProvider>
  );
}

function renderRow(tabId: string, chat: CloudChatSummary): HTMLElement {
  render(rowTree(tabId, chat));
  return screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`);
}

function rowStateOf(row: HTMLElement): {
  selected: string | null;
  highlighted: boolean;
} {
  const item = row.closest("li");
  if (item === null) throw new Error("expected the row inside its treeitem");
  return {
    selected: item.getAttribute("aria-selected"),
    highlighted: row.className.includes("bg-accent "),
  };
}

describe("EpicSidebarCloudChatRow active state (real canvas store)", () => {
  it("highlights when the real store's active tile is this chat's LIVE ref", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    // The exact ref shape the row's own click opens for a reachable owner.
    useEpicCanvasStore.getState().openTileInTab(tabId, {
      id: CHAT.identity.chatId,
      instanceId: uuidv4(),
      type: "chat",
      name: "Walkthrough",
      hostId: CHAT.ownerHostId,
    });

    const row = renderRow(tabId, CHAT);
    expect(rowStateOf(row)).toEqual({ selected: "true", highlighted: true });
  });

  it("highlights when the active tile is this chat's PUBLISHED COPY", () => {
    // A published tile is not record-backed, so the artifact selector answers
    // null for it - only the composite tile-id comparison can light this row.
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makePublishedChatTileRef({
        taskId: CHAT.identity.taskId,
        chatId: CHAT.identity.chatId,
        ownerUserId: CHAT.identity.ownerUserId,
        ownerHostId: CHAT.ownerHostId,
        name: "Walkthrough",
        hostId: "host-a",
      }),
    );

    const row = renderRow(tabId, CHAT);
    expect(rowStateOf(row)).toEqual({ selected: "true", highlighted: true });
  });

  it("stays inactive while the real store shows a DIFFERENT chat", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    useEpicCanvasStore.getState().openTileInTab(tabId, {
      id: uuidv4(),
      instanceId: uuidv4(),
      type: "chat",
      name: "Some other chat",
      hostId: CHAT.ownerHostId,
    });

    const row = renderRow(tabId, CHAT);
    expect(rowStateOf(row)).toEqual({ selected: "false", highlighted: false });
  });
});

describe("EpicSidebarCloudChatRow first-title label (real canvas store)", () => {
  const UNTITLED: CloudChatSummary = { ...CHAT, title: null };

  function openedTileNames(tabId: string): ReadonlyArray<string | undefined> {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    return Object.values(canvas?.tilesByInstanceId ?? {}).map(
      (tile) => tile?.name,
    );
  }

  it("paints New agent for a title-less row, mark or none, and opens a tile of the same name", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    act(() => {
      useEpicCanvasStore
        .getState()
        .markChatTitlePending(CHAT.identity.chatId, "");
    });

    const row = renderRow(tabId, UNTITLED);

    expect(row.getAttribute("aria-label")).toContain("New agent");
    expect(row.textContent).toContain("New agent");
    fireEvent.click(row);
    expect(openedTileNames(tabId)).toEqual(["New agent"]);
  });

  it("paints New agent for a title-less row no window marked, then takes the title in the same single row", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    const { rerender } = render(rowTree(tabId, UNTITLED));
    const row = screen.getByTestId(
      `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
    );

    expect(row.getAttribute("aria-label")).toContain("New agent");
    expect(row.textContent).not.toContain("Untitled");

    rerender(rowTree(tabId, CHAT));

    expect(
      screen.getAllByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    ).toHaveLength(1);
    expect(row.getAttribute("aria-label")).toContain("Walkthrough");
    expect(row.textContent).not.toContain("New agent");
  });

  it("paints New agent for a locked row whose owner is out of reach, and opens a published tile of the same name", () => {
    reachability.status = "unreachable";
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    act(() => {
      useEpicCanvasStore
        .getState()
        .markChatTitlePending(CHAT.identity.chatId, "");
    });

    const row = renderRow(tabId, UNTITLED);

    expect(row.getAttribute("aria-label")).toContain("New agent");
    expect(row.textContent).toContain("New agent");
    fireEvent.click(row);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const tiles = Object.values(canvas?.tilesByInstanceId ?? {});
    expect(tiles.map((tile) => tile?.name)).toEqual(["New agent"]);
    expect(tiles.map((tile) => tile?.id)).not.toEqual([CHAT.identity.chatId]);
  });

  it("keeps a titled row's title under a mark", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(CHAT.identity.taskId, "Epic");
    act(() => {
      useEpicCanvasStore
        .getState()
        .markChatTitlePending(CHAT.identity.chatId, "");
    });

    const row = renderRow(tabId, CHAT);

    expect(row.getAttribute("aria-label")).toContain("Walkthrough");
    expect(row.textContent).not.toContain("New agent");
  });
});
