import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
  TREE_GUIDE_OFFSET_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  TAB_ID,
  itemOf,
  mountedChatIds,
  mountedItems,
  openChatSession,
  renderChatTree,
  rootChats,
  topOf,
  treeList,
  type SeedChat,
} from "./chat-tree-test-support";
/**
 * What the virtual list draws for the chat tree: where each row sits, how many
 * are mounted, and the structure a screen reader and the eye read off them.
 */
vi.mock("@tanstack/react-virtual", async (importOriginal) =>
  (await import("@/__tests__/chat-tree-virtual-layout")).mockReactVirtual(
    importOriginal,
  ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).hostClientForHostIdMock(
    importOriginal,
  ),
);
vi.mock(
  "@/hooks/epic/use-task-hosts-view",
  async () => (await import("./chat-tree-host-mocks")).taskHostsViewMock,
);
vi.mock(
  "@/hooks/pr/use-owner-pr-references",
  async () => (await import("./chat-tree-host-mocks")).ownerPrReferencesMock,
);
vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) =>
    (await import("./chat-tree-host-mocks")).notificationIndicatorsMock(
      importOriginal,
    ),
);
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).hostReachabilityMock(importOriginal),
);
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).cloudChatQueriesMock(importOriginal),
);
const sessions: OpenedStoreForTest[] = [];
function mountTree(chats: readonly SeedChat[]): void {
  const session = openChatSession(chats);
  sessions.push(session);
  renderChatTree(session);
}
beforeEach(() => {
  chatTreeLayout.reset();
});
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
});
const SHORT_PX = 28;
/** A row's height plus the 2px gap above every row but the first of its group. */
const ROW_PITCH_PX = 30;
const TALL_PX = 56;
describe("chat tree row placement", () => {
  it("places each row below the heights of those above it when rows differ in height", () => {
    chatTreeLayout.setRowHeight((_key, index) =>
      index % 2 === 0 ? TALL_PX : SHORT_PX,
    );
    mountTree(rootChats(8));
    const items = mountedItems();
    expect(items).toHaveLength(8);
    let expectedTop = 0;
    items.forEach((item, index) => {
      expect(topOf(item)).toBe(expectedTop);
      expectedTop += index % 2 === 0 ? TALL_PX : SHORT_PX;
    });
    expect(parseFloat(treeList().style.height)).toBe(expectedTop);
  });
});
describe("chat tree windowing", () => {
  const ROWS = 2000;
  const VIEWPORT_PX = 280;
  const OVERSCAN = 10;
  const MOUNT_BOUND = Math.ceil(VIEWPORT_PX / SHORT_PX) + 2 * OVERSCAN + 2;
  it("mounts the window and its overscan of a 2,000-row tree, not every row", () => {
    chatTreeLayout.setViewport(VIEWPORT_PX);
    mountTree(rootChats(ROWS));
    const mounted = mountedChatIds();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(MOUNT_BOUND);
    expect(mounted[0]).toBe("c0");
    expect(treeList().getAttribute("data-chat-tree-row-count")).toBe(
      String(ROWS),
    );
  });
  it("mounts the middle rows and unmounts the top ones after scrolling to the middle", () => {
    chatTreeLayout.setViewport(VIEWPORT_PX);
    mountTree(rootChats(ROWS));
    chatTreeLayout.scrollTo(1000 * ROW_PITCH_PX);
    const mounted = mountedChatIds();
    expect(mounted.length).toBeLessThanOrEqual(MOUNT_BOUND);
    expect(mounted).toContain("c1000");
    // The first and last rows stay mounted for Tab into the tree; the rows
    // after the first go with the window.
    expect(mounted).not.toContain("c5");
    expect(screen.queryByTestId("epic-sidebar-item-c5")).toBeNull();
    expect(treeList().getAttribute("data-chat-tree-row-count")).toBe(
      String(ROWS),
    );
  });
});
describe("chat tree structure", () => {
  const NESTED: readonly SeedChat[] = [
    { id: "root", parentId: null, updatedAt: 900 },
    { id: "child-a", parentId: "root", updatedAt: 800 },
    { id: "child-b", parentId: "root", updatedAt: 700 },
    { id: "grandchild", parentId: "child-a", updatedAt: 600 },
  ];
  function expandAll(): void {
    useEpicSidebarExpansionStore.getState().expand(TAB_ID, "chats", "root");
    useEpicSidebarExpansionStore.getState().expand(TAB_ID, "chats", "child-a");
  }
  it("gives each row its level, position and size, and expansion only on a branch", () => {
    expandAll();
    mountTree(NESTED);
    const attrs = (id: string) => {
      const item = itemOf(id);
      return [
        item.getAttribute("aria-level"),
        item.getAttribute("aria-posinset"),
        item.getAttribute("aria-setsize"),
        item.getAttribute("aria-expanded"),
      ];
    };
    expect(attrs("root")).toEqual(["1", "1", "1", "true"]);
    expect(attrs("child-a")).toEqual(["2", "1", "2", "true"]);
    expect(attrs("child-b")).toEqual(["2", "2", "2", null]);
    expect(attrs("grandchild")).toEqual(["3", "1", "1", null]);
  });
  /** The rails the list drew, by the key of the row that owns each. */
  function railsByOwner(): Map<string, HTMLElement> {
    const rails = new Map<string, HTMLElement>();
    for (const rail of treeList().querySelectorAll<HTMLElement>(
      "[data-tree-guide-for]",
    )) {
      rails.set(rail.getAttribute("data-tree-guide-for") ?? "", rail);
    }
    return rails;
  }
  /** The rail of the row of chat `chatId`: its owner key ends in that chat. */
  function railOf(chatId: string): HTMLElement {
    for (const [key, rail] of railsByOwner()) {
      if (key.endsWith(`local:${chatId}`)) return rail;
    }
    throw new Error(`no rail owned by ${chatId}`);
  }
  const railAt = (depth: number): string =>
    `${depth * INDENT_PX + BASE_PAD_LEFT + TREE_GUIDE_OFFSET_PX}px`;
  it("draws one rail per open group beside the rows, at the base rail positions", () => {
    expandAll();
    mountTree(NESTED);
    expect(railsByOwner().size).toBe(2);
    expect(railOf("root").style.left).toBe(railAt(0));
    expect(railOf("child-a").style.left).toBe(railAt(1));
    for (const rail of railsByOwner().values()) {
      expect(rail.parentElement).toBe(treeList());
    }
    // Never inside a row: a leaf row owns no group, and a row holds no rail.
    for (const id of ["root", "child-a", "child-b", "grandchild"]) {
      expect(itemOf(id).querySelector("[data-tree-guide-for]")).toBeNull();
    }
  });
  it("runs each rail from its owner row's bottom to 2px above its last descendant's bottom, nested groups included", () => {
    expandAll();
    // Heights that differ, so a rail drawn from the estimates or from the
    // row's index cannot match: root 0-40, child-a 40-100, grandchild
    // 100-128, child-b 128-160.
    const heights: Readonly<Record<string, number>> = {
      root: 40,
      "child-a": 60,
      grandchild: 28,
      "child-b": 32,
    };
    chatTreeLayout.setRowHeight((key) => {
      const own = key.split("/").pop()?.replace("local:", "") ?? "";
      return heights[own];
    });
    mountTree(NESTED);
    const root = railOf("root");
    expect(parseFloat(root.style.top)).toBe(40);
    expect(parseFloat(root.style.top) + parseFloat(root.style.height)).toBe(
      160 - 2,
    );
    const childA = railOf("child-a");
    expect(parseFloat(childA.style.top)).toBe(100);
    expect(parseFloat(childA.style.top) + parseFloat(childA.style.height)).toBe(
      128 - 2,
    );
  });
  it("ends a rail at its own last descendant when another group follows it", () => {
    useEpicSidebarExpansionStore.getState().expand(TAB_ID, "chats", "first");
    useEpicSidebarExpansionStore.getState().expand(TAB_ID, "chats", "second");
    // first 0-30, its children 30-58 and 58-90, second 90-130, its child
    // 130-158.
    const heights: Readonly<Record<string, number>> = {
      first: 30,
      "first-1": 28,
      "first-2": 32,
      second: 40,
      "second-1": 28,
    };
    chatTreeLayout.setRowHeight((key) => {
      const own = key.split("/").pop()?.replace("local:", "") ?? "";
      return heights[own];
    });
    mountTree([
      { id: "first", parentId: null, updatedAt: 900 },
      { id: "first-1", parentId: "first", updatedAt: 800 },
      { id: "first-2", parentId: "first", updatedAt: 700 },
      { id: "second", parentId: null, updatedAt: 500 },
      { id: "second-1", parentId: "second", updatedAt: 400 },
    ]);
    const first = railOf("first");
    expect(parseFloat(first.style.top)).toBe(30);
    expect(parseFloat(first.style.top) + parseFloat(first.style.height)).toBe(
      90 - 2,
    );
    const second = railOf("second");
    expect(parseFloat(second.style.top)).toBe(130);
    expect(parseFloat(second.style.top) + parseFloat(second.style.height)).toBe(
      158 - 2,
    );
  });
  it("puts the 2px gap above every row but the first of its group", () => {
    expandAll();
    mountTree(NESTED);
    expect(itemOf("root").classList.contains("pt-0.5")).toBe(false);
    expect(itemOf("child-a").classList.contains("pt-0.5")).toBe(false);
    expect(itemOf("child-b").classList.contains("pt-0.5")).toBe(true);
    expect(itemOf("grandchild").classList.contains("pt-0.5")).toBe(false);
  });
});
