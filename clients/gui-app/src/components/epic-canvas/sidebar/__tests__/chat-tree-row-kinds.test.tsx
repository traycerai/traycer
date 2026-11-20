import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  EPIC_ID,
  TAB_ID,
  itemOf,
  mountedChatIds,
  mountedItems,
  openChatSession,
  renderChatTree,
  type SeedChat,
} from "./chat-tree-test-support";
import { cloudChatRowKey } from "@/lib/chats/unified-chat-list";
import { cloudSummary } from "./chat-tree-row-fixtures";
import { setCloudChats, setRunningChats } from "./chat-tree-host-mocks";

/**
 * Rows of each kind the tree draws: a collapsed parent's status rollup, a
 * shared orchestrator's subagents, and the rows of agents still being created.
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

vi.mock("@/lib/epic-selectors", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).epicSelectorsMock(importOriginal),
);

let session: OpenedStoreForTest | null = null;

beforeEach(() => {
  chatTreeLayout.reset();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
});

afterEach(() => {
  cleanup();
  session?.dispose();
  session = null;
  setCloudChats([]);
  setRunningChats([]);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
  useEpicCanvasStore.setState({ pendingRootCreatesByEpic: {} });
});

function mountTree(chats: readonly SeedChat[]): void {
  session = openChatSession(chats);
  renderChatTree(session);
}

/** A root draws expanded until its person collapses it; start from collapsed. */
function collapse(expansionId: string): void {
  useEpicSidebarExpansionStore
    .getState()
    .collapse(TAB_ID, "chats", expansionId);
}

function chevronOf(testId: string): Element {
  const chevron = screen
    .getByTestId(testId)
    .querySelector('span[aria-hidden="true"].cursor-pointer');
  if (chevron === null) throw new Error(`no chevron on ${testId}`);
  return chevron;
}

describe("nested status of a collapsed parent", () => {
  const FAMILY: readonly SeedChat[] = [
    { id: "parent", parentId: null, updatedAt: 900 },
    { id: "child", parentId: "parent", updatedAt: 800 },
  ];

  it("shows the running child's status on the collapsed parent, and the child row once expanded", () => {
    setRunningChats(["child"]);
    collapse("parent");
    mountTree(FAMILY);

    expect(
      screen.getByTestId("chat-descendant-status-running-parent"),
    ).toBeTruthy();
    expect(screen.queryByTestId("epic-sidebar-item-child")).toBeNull();

    fireEvent.click(chevronOf("epic-sidebar-item-parent"));

    expect(screen.getByTestId("epic-sidebar-item-child")).toBeTruthy();
    expect(
      screen.queryByTestId("chat-descendant-status-running-parent"),
    ).toBeNull();
    expect(itemOf("child").getAttribute("aria-level")).toBe("2");
  });
});

describe("a shared orchestrator's subagents", () => {
  const ORCHESTRATOR = cloudSummary("orchestrator", null, "Orchestrator");
  const SUBAGENTS = [
    cloudSummary("sub-a", "orchestrator", "Sub A"),
    cloudSummary("sub-b", "orchestrator", "Sub B"),
  ];

  it("expands them one level deeper from the chevron and hides them again on collapse", () => {
    setCloudChats([ORCHESTRATOR, ...SUBAGENTS]);
    collapse(cloudChatRowKey(ORCHESTRATOR.identity));
    mountTree([]);
    expect(mountedItems()).toHaveLength(1);

    fireEvent.click(chevronOf("epic-sidebar-cloud-item-orchestrator"));

    expect(
      mountedItems().map((item) => item.getAttribute("aria-level")),
    ).toEqual(["1", "2", "2"]);
    expect(screen.getByTestId("epic-sidebar-cloud-item-sub-a")).toBeTruthy();
    expect(screen.getByTestId("epic-sidebar-cloud-item-sub-b")).toBeTruthy();

    fireEvent.click(chevronOf("epic-sidebar-cloud-item-orchestrator"));

    expect(mountedItems()).toHaveLength(1);
    expect(screen.queryByTestId("epic-sidebar-cloud-item-sub-a")).toBeNull();
  });
});

describe("rows of agents being created", () => {
  it("draws them after every agent, each with its spinner and name", () => {
    mountTree([
      { id: "a1", parentId: null, updatedAt: 900 },
      { id: "a2", parentId: null, updatedAt: 800 },
    ]);

    act(() => {
      useEpicCanvasStore
        .getState()
        .registerPendingRootCreate(EPIC_ID, "p1", "Creating one");
      useEpicCanvasStore
        .getState()
        .registerPendingRootCreate(EPIC_ID, "p2", "Creating two");
    });

    expect(mountedChatIds().slice(0, 2)).toEqual(["a1", "a2"]);
    const pending = screen.getAllByTestId("epic-sidebar-pending-create");
    expect(pending).toHaveLength(2);
    expect(pending[0].textContent).toContain("Creating one");
    expect(pending[1].textContent).toContain("Creating two");
    const items = mountedItems();
    items.slice(2).forEach((item, index) => {
      expect(item.contains(pending[index])).toBe(true);
    });
    for (const row of pending) {
      expect(row.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });
});
