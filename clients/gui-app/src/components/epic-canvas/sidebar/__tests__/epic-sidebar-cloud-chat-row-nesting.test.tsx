import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { CloudChatTree } from "@/components/epic-canvas/sidebar/__tests__/cloud-chat-tree";
import { leafCloudEntry } from "@/components/epic-canvas/sidebar/__tests__/cloud-chat-tree-entries";
import {
  cloudChatRowKey,
  type UnifiedChatEntry,
} from "@/lib/chats/unified-chat-list";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";

/**
 * Nested shared subagents: a cloud row's children are rows of the chat tree's
 * list, drawn beneath it while it is expanded, and its chevron asks the panel
 * to toggle it.
 */

vi.mock("@tanstack/react-virtual", async (importOriginal) =>
  (await import("@/__tests__/chat-tree-virtual-layout")).mockReactVirtual(
    importOriginal,
  ),
);

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

beforeEach(() => {
  chatTreeLayout.reset();
});

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

const PARENT = summary("parent-chat", null);
const CHILD_A = summary("child-a", "parent-chat");
const CHILD_B = summary("child-b", "parent-chat");
const PARENT_KEY = cloudChatRowKey(PARENT.identity);
const NESTED_PARENT: readonly UnifiedChatEntry[] = [
  {
    ...leafCloudEntry(PARENT),
    children: [leafCloudEntry(CHILD_A), leafCloudEntry(CHILD_B)],
  },
];
const LEAF_PARENT: readonly UnifiedChatEntry[] = [leafCloudEntry(PARENT)];

function renderParent(input: {
  readonly listEntries: readonly UnifiedChatEntry[];
  readonly expandedIds: ReadonlySet<string>;
  readonly toggleExpanded: (id: string) => void;
}): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CloudChatTree {...input} tabId="tab-1" />
    </QueryClientProvider>,
  );
}

function rowButton(chatId: string): HTMLElement {
  return screen.getByTestId(`epic-sidebar-cloud-item-${chatId}`);
}

function treeItemOf(chatId: string): HTMLElement {
  const item = rowButton(chatId).closest<HTMLElement>('[role="treeitem"]');
  if (item === null) throw new Error(`no treeitem for ${chatId}`);
  return item;
}

describe("EpicSidebarCloudChatRow nesting", () => {
  it("draws the children beneath the parent, one level deeper and indented, when expanded", () => {
    renderParent({
      listEntries: NESTED_PARENT,
      expandedIds: new Set([PARENT_KEY]),
      toggleExpanded: vi.fn(),
    });
    const parentItem = treeItemOf("parent-chat");
    expect(parentItem.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen
        .getAllByRole("treeitem")
        .map((item) => [
          item
            .querySelector("[data-testid^='epic-sidebar-cloud-item-']")
            ?.getAttribute("data-testid"),
          item.getAttribute("aria-level"),
          item.getAttribute("aria-posinset"),
          item.getAttribute("aria-setsize"),
        ]),
    ).toEqual([
      ["epic-sidebar-cloud-item-parent-chat", "1", "1", "1"],
      ["epic-sidebar-cloud-item-child-a", "2", "1", "2"],
      ["epic-sidebar-cloud-item-child-b", "2", "2", "2"],
    ]);
    const parentPad = parseFloat(rowButton("parent-chat").style.paddingLeft);
    const childPad = parseFloat(rowButton("child-a").style.paddingLeft);
    expect(childPad).toBeGreaterThan(parentPad);
  });

  it("draws no children when collapsed", () => {
    renderParent({
      listEntries: NESTED_PARENT,
      expandedIds: new Set<string>(),
      toggleExpanded: vi.fn(),
    });
    expect(treeItemOf("parent-chat").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(screen.queryByTestId("epic-sidebar-cloud-item-child-a")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-cloud-item-child-b")).toBeNull();
  });

  it("carries no aria-expanded on a leaf", () => {
    renderParent({
      listEntries: LEAF_PARENT,
      expandedIds: new Set<string>(),
      toggleExpanded: vi.fn(),
    });
    expect(treeItemOf("parent-chat").hasAttribute("aria-expanded")).toBe(false);
  });

  it("toggles by row key from the chevron without opening the chat", () => {
    const toggleExpanded = vi.fn();
    renderParent({
      listEntries: NESTED_PARENT,
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
      listEntries: NESTED_PARENT,
      expandedIds: new Set<string>(),
      toggleExpanded,
    });
    fireEvent.click(rowButton("parent-chat"));
    expect(openTile).toHaveBeenCalledTimes(1);
    expect(toggleExpanded).not.toHaveBeenCalled();
  });
});
