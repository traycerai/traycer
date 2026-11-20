import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { FlattenChatTreeRowsInput } from "@/components/epic-canvas/sidebar/chat-tree-rows";
import {
  TAB_ID,
  mountedChatIds,
  mountedItems,
  openChatSession,
  renderChatTree,
  upsertChat,
  type SeedChat,
} from "./chat-tree-test-support";

/**
 * The panel's row model is built from what React has committed, so an update
 * costs the panel body one render per commit: no render is thrown away and run
 * again.
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

const passes = vi.hoisted(() => ({ renders: 0, commits: 0 }));

vi.mock(
  "@/components/epic-canvas/sidebar/use-chat-tree-row-model",
  async (importOriginal) => {
    const React = await import("react");
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/sidebar/use-chat-tree-row-model")
      >();
    return {
      ...actual,
      useChatTreeRowModel: (input: FlattenChatTreeRowsInput) => {
        passes.renders += 1;
        React.useLayoutEffect(() => {
          passes.commits += 1;
        });
        return actual.useChatTreeRowModel(input);
      },
    };
  },
);

const FAMILY: readonly SeedChat[] = [
  { id: "root", parentId: null, updatedAt: 900 },
  { id: "child-a", parentId: "root", updatedAt: 800 },
  { id: "child-b", parentId: "root", updatedAt: 700 },
];

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
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
});

function mountTree(): OpenedStoreForTest {
  session = openChatSession(FAMILY);
  renderChatTree(session);
  return session;
}

interface PassCounts {
  readonly renders: number;
  readonly commits: number;
}

async function countPasses(
  update: () => Promise<void> | void,
): Promise<PassCounts> {
  const before = { ...passes };
  await update();
  return {
    renders: passes.renders - before.renders,
    commits: passes.commits - before.commits,
  };
}

function drawnRows(): string[][] {
  return mountedItems().map((item, index) => [
    mountedChatIds()[index],
    item.getAttribute("aria-level") ?? "",
    item.getAttribute("aria-posinset") ?? "",
  ]);
}

describe("the panel's render passes per update", () => {
  it("renders once per commit when a root is expanded, and draws its children in order", async () => {
    useEpicSidebarExpansionStore.getState().collapse(TAB_ID, "chats", "root");
    mountTree();
    expect(mountedChatIds()).toEqual(["root"]);
    const chevron = screen
      .getByTestId("epic-sidebar-item-root")
      .querySelector('span[aria-hidden="true"].cursor-pointer');
    if (chevron === null) throw new Error("no chevron on the root");

    const counts = await countPasses(() => {
      fireEvent.click(chevron);
    });

    expect(counts.commits).toBeGreaterThan(0);
    expect(counts.renders).toBe(counts.commits);
    expect(drawnRows()).toEqual([
      ["root", "1", "1"],
      ["child-a", "2", "1"],
      ["child-b", "2", "2"],
    ]);
  });

  it("renders once per commit when a child arrives through the store, and draws it in order", async () => {
    const handle = mountTree();
    expect(mountedChatIds()).toEqual(["root", "child-a", "child-b"]);

    const counts = await countPasses(async () => {
      await act(async () => {
        upsertChat(handle, { id: "child-c", parentId: "root", updatedAt: 600 });
        await handle.flush();
      });
    });

    expect(counts.commits).toBeGreaterThan(0);
    expect(counts.renders).toBe(counts.commits);
    expect(drawnRows()).toEqual([
      ["root", "1", "1"],
      ["child-a", "2", "1"],
      ["child-b", "2", "2"],
      ["child-c", "2", "3"],
    ]);
  });
});
