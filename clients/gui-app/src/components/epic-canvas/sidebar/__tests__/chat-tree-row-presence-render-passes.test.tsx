import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { LazyMotion, domMax } from "motion/react";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  EPIC_ID,
  TAB_ID,
  mountedChatIds,
  mountedItems,
  openChatSession,
  treeList,
  upsertChat,
  type SeedChat,
} from "./chat-tree-test-support";

/**
 * The list draws the rows that are still fading out beside the model's own, and
 * derives them from what React has committed, so a model change costs the list
 * one render per commit: no render is thrown away and run again. It counts the
 * passes of the hook the list calls once per render.
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
const passes = vi.hoisted(() => ({
  renders: 0,
  commits: 0,
  /** What each commit drew: the rows fading, and the rows in all. */
  trail: [] as { departing: number; rows: number }[],
}));
vi.mock(
  "@/components/epic-canvas/sidebar/use-chat-tree-row-presence",
  async (importOriginal) => {
    const React = await import("react");
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/sidebar/use-chat-tree-row-presence")
      >();
    return {
      ...actual,
      useChatTreeRowPresence: (
        ...args: Parameters<typeof actual.useChatTreeRowPresence>
      ) => {
        passes.renders += 1;
        const presence = actual.useChatTreeRowPresence(...args);
        const drawn = {
          departing: presence.departing.size,
          rows: presence.model.rows.length,
        };
        React.useLayoutEffect(() => {
          passes.commits += 1;
          passes.trail.push(drawn);
        });
        return presence;
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

/**
 * The tree as the app draws it: inside `LazyMotion`, which is what lets a row
 * that leaves fade out where it stood instead of going at once.
 */
function mountTree(): OpenedStoreForTest {
  const opened = openChatSession(FAMILY);
  session = opened;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={opened}>
        <DndContext>
          <LazyMotion features={domMax}>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </LazyMotion>
        </DndContext>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  return opened;
}
interface PassCounts {
  readonly renders: number;
  readonly commits: number;
}
async function countPasses(update: () => Promise<void>): Promise<PassCounts> {
  const before = { ...passes };
  await update();
  return {
    renders: passes.renders - before.renders,
    commits: passes.commits - before.commits,
  };
}
describe("the row presence's render passes per update", () => {
  it("renders once per commit when a root arrives through the store, and draws it first", async () => {
    const handle = mountTree();
    expect(mountedChatIds()).toEqual(["root", "child-a", "child-b"]);
    const counts = await countPasses(async () => {
      await act(async () => {
        upsertChat(handle, { id: "newest", parentId: null, updatedAt: 950 });
        await handle.flush();
      });
    });
    expect(counts.commits).toBeGreaterThan(0);
    expect(
      counts.renders,
      `renders against commits; what each commit drew: ${JSON.stringify(passes.trail)}`,
    ).toBe(counts.commits);
    expect(mountedChatIds()).toEqual(["newest", "root", "child-a", "child-b"]);
  });

  it("draws a row that left its group while it fades, then draws it gone in one more commit", async () => {
    useEpicSidebarExpansionStore.getState().expand(TAB_ID, "chats", "child-a");
    const handle = mountTree();
    expect(mountedChatIds()).toEqual(["root", "child-a", "child-b"]);
    // The most rows the tree has drawn at once from here on: the row's old
    // place is drawn beside its new one for as long as it fades.
    let mostDrawn = mountedItems().length;
    const watcher = new MutationObserver(() => {
      mostDrawn = Math.max(mostDrawn, mountedItems().length);
    });
    watcher.observe(treeList(), { childList: true });
    // child-b moves under child-a: its place under the root is left while the
    // root stays open and the chat stays in the task.
    const trailStart = passes.trail.length;
    const counts = await countPasses(async () => {
      await act(async () => {
        upsertChat(handle, {
          id: "child-b",
          parentId: "child-a",
          updatedAt: 700,
        });
        await handle.flush();
      });
      // The fade ends, and the row is dropped.
      await waitFor(() => {
        expect(mountedItems()).toHaveLength(3);
      });
    });
    watcher.disconnect();
    expect(mostDrawn, "rows drawn at once while the old place fades").toBe(4);
    // What the tree drew, one entry for each change of what it drew: the old
    // place beside the new one while it fades, then the row dropped. The list
    // also re-renders between the two with nothing new to draw.
    const drawn = passes.trail
      .slice(trailStart)
      .filter(
        (entry, index, all) =>
          index === 0 ||
          entry.departing !== all[index - 1].departing ||
          entry.rows !== all[index - 1].rows,
      );
    expect(drawn).toEqual([
      { departing: 1, rows: 4 },
      { departing: 0, rows: 3 },
    ]);
    // No render is thrown away along the way.
    expect(
      counts.renders,
      `renders against commits; what each commit drew: ${JSON.stringify(passes.trail.slice(trailStart))}`,
    ).toBe(counts.commits);
    expect(mountedChatIds()).toEqual(["root", "child-a", "child-b"]);
  });
});
