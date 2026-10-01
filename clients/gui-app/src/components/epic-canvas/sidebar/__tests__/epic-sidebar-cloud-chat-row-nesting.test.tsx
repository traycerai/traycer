import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import {
  cloudChatRowKey,
  type UnifiedCloudChatEntry,
} from "@/lib/chats/unified-chat-list";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";

/** Nested shared subagents: the tree affordances of a cloud row. */

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

const openTile = vi.fn((_intent: TileOpenIntent) => undefined);

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useIsActiveEpicArtifact: () => false,
  useIsActiveTile: () => false,
}));

afterEach(() => {
  cleanup();
  openTile.mockClear();
});

const TASK = "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7";
const OWNER = "user-1";

function summary(
  chatId: string,
  parentChatId: string | null,
): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId, ownerUserId: OWNER },
    ownerHostId: "host-b",
    createdAt: 100,
    visibility: "task",
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 300,
    headSha256: null,
    publishedAt: 300,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

function leafEntry(chat: CloudChatSummary): UnifiedCloudChatEntry {
  return {
    kind: "cloud",
    key: cloudChatRowKey(chat.identity),
    chat,
    children: [],
  };
}

const PARENT = summary("parent-chat", null);
const CHILD_A = summary("child-a", "parent-chat");
const CHILD_B = summary("child-b", "parent-chat");
const CHILD_ENTRIES: readonly UnifiedCloudChatEntry[] = [
  leafEntry(CHILD_A),
  leafEntry(CHILD_B),
];
const PARENT_KEY = cloudChatRowKey(PARENT.identity);

function renderParent(input: {
  readonly childEntries: readonly UnifiedCloudChatEntry[];
  readonly expandedIds: ReadonlySet<string>;
  readonly toggleExpanded: (id: string) => void;
}): void {
  render(
    <ul role="tree">
      <EpicSidebarCloudChatRow
        chat={PARENT}
        childEntries={input.childEntries}
        expansion={{
          expandedIds: input.expandedIds,
          toggleExpanded: input.toggleExpanded,
        }}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />
    </ul>,
  );
}

function rowButton(chatId: string): HTMLElement {
  return screen.getByTestId(`epic-sidebar-cloud-item-${chatId}`);
}

function treeItemOf(chatId: string): HTMLElement {
  const item = rowButton(chatId).closest("li");
  if (item === null) throw new Error(`no treeitem for ${chatId}`);
  return item;
}

describe("EpicSidebarCloudChatRow nesting", () => {
  it("renders children inside a group, indented deeper, when expanded", () => {
    renderParent({
      childEntries: CHILD_ENTRIES,
      expandedIds: new Set([PARENT_KEY]),
      toggleExpanded: vi.fn(),
    });
    const parentItem = treeItemOf("parent-chat");
    expect(parentItem.getAttribute("aria-expanded")).toBe("true");
    const group = within(parentItem).getByRole("group");
    expect(within(group).getAllByRole("treeitem")).toHaveLength(2);
    expect(
      within(group).getByTestId("epic-sidebar-cloud-item-child-a"),
    ).toBeTruthy();
    expect(
      within(group).getByTestId("epic-sidebar-cloud-item-child-b"),
    ).toBeTruthy();
    const parentPad = parseFloat(rowButton("parent-chat").style.paddingLeft);
    const childPad = parseFloat(rowButton("child-a").style.paddingLeft);
    expect(childPad).toBeGreaterThan(parentPad);
  });

  it("hides children and the group when collapsed", () => {
    renderParent({
      childEntries: CHILD_ENTRIES,
      expandedIds: new Set<string>(),
      toggleExpanded: vi.fn(),
    });
    expect(treeItemOf("parent-chat").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-cloud-item-child-a")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-cloud-item-child-b")).toBeNull();
  });

  it("carries no aria-expanded on a leaf", () => {
    renderParent({
      childEntries: [],
      expandedIds: new Set<string>(),
      toggleExpanded: vi.fn(),
    });
    expect(treeItemOf("parent-chat").hasAttribute("aria-expanded")).toBe(false);
  });

  it("toggles by row key from the chevron without opening the chat", () => {
    const toggleExpanded = vi.fn();
    renderParent({
      childEntries: CHILD_ENTRIES,
      expandedIds: new Set<string>(),
      toggleExpanded,
    });
    const chevron = rowButton("parent-chat").querySelector(
      'span[aria-hidden="true"].cursor-pointer',
    );
    if (chevron === null) throw new Error("no chevron rendered");
    fireEvent.click(chevron);
    expect(toggleExpanded).toHaveBeenCalledTimes(1);
    expect(toggleExpanded).toHaveBeenCalledWith(PARENT_KEY);
    expect(openTile).not.toHaveBeenCalled();
  });

  it("still opens the chat when the row button itself is clicked", () => {
    const toggleExpanded = vi.fn();
    renderParent({
      childEntries: CHILD_ENTRIES,
      expandedIds: new Set<string>(),
      toggleExpanded,
    });
    fireEvent.click(rowButton("parent-chat"));
    expect(openTile).toHaveBeenCalledTimes(1);
    expect(toggleExpanded).not.toHaveBeenCalled();
  });
});
