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

  it("draws one guide rail per enclosing group, at the base rail positions", () => {
    expandAll();
    mountTree(NESTED);

    const railLefts = (id: string): string[] =>
      Array.from(
        itemOf(id).querySelectorAll<HTMLElement>(":scope > span[aria-hidden]"),
      ).map((rail) => rail.style.left);
    const railAt = (depth: number): string =>
      `${depth * INDENT_PX + BASE_PAD_LEFT + TREE_GUIDE_OFFSET_PX}px`;
    expect(railLefts("root")).toEqual([]);
    expect(railLefts("child-a")).toEqual([railAt(0)]);
    expect(railLefts("grandchild")).toEqual([railAt(0), railAt(1)]);
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
