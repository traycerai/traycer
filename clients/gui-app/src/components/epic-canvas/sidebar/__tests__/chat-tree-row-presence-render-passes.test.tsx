import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { LazyMotion, domMax, usePresence } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { ChatTreeVirtualList } from "@/components/epic-canvas/sidebar/chat-tree-virtual-list";
import type { EpicTreeIndex } from "@/lib/epic-selectors";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import {
  flattenChatTreeRows,
  indexRowsByKey,
  type ChatTreeRowModel,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";
import { useChatTreeRowPresence } from "@/components/epic-canvas/sidebar/use-chat-tree-row-presence";
import {
  chatNode,
  flattenInput,
  localEntry,
  treeOf,
} from "./chat-tree-row-fixtures";
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
    const oldItem = mountedItems()[2];
    const button = oldItem.querySelector<HTMLElement>(
      '[data-testid="epic-sidebar-item-child-b"]',
    );
    if (button === null) throw new Error("missing outgoing row control");
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    const exit = Promise.withResolvers<void>();
    let duringExit:
      | {
          readonly hidden: string | null;
          readonly focusedNode: string | null;
          readonly visiblePlaces: readonly (string | null)[];
        }
      | undefined;
    const watcher = new MutationObserver(() => {
      if (
        oldItem.isConnected &&
        oldItem.hasAttribute("inert") &&
        duringExit === undefined
      ) {
        duringExit = {
          hidden: oldItem.getAttribute("aria-hidden"),
          focusedNode:
            document.activeElement?.getAttribute("data-row-key") ?? null,
          visiblePlaces: mountedItems().map((item) =>
            item.getAttribute("aria-posinset"),
          ),
        };
      }
      if (!oldItem.isConnected) exit.resolve();
    });
    watcher.observe(treeList(), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert"],
    });
    // child-b moves under child-a: its place under the root is left while the
    // root stays open and the chat stays in the task.
    const trailStart = passes.trail.length;
    const counts = await countPasses(async () => {
      try {
        await act(async () => {
          upsertChat(handle, {
            id: "child-b",
            parentId: "child-a",
            updatedAt: 700,
          });
          await handle.flush();
        });
        await exit.promise;
      } finally {
        watcher.disconnect();
      }
    });
    expect(duringExit).toEqual({
      hidden: "true",
      focusedNode: "local:root/local:child-a/local:child-b",
      visiblePlaces: ["1", "1", "1"],
    });
    expect(mountedItems()).toHaveLength(3);
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

function presenceModel(
  revision: number,
  tree: EpicTreeIndex,
  roots: readonly string[],
  input: {
    readonly expanded: readonly string[];
    readonly visible: ReadonlySet<string> | null;
  },
): ChatTreeRowModel {
  const rows = flattenChatTreeRows(
    flattenInput({
      tree,
      listEntries: roots.map(localEntry),
      expandedIds: new Set(input.expanded),
      visibleIds: input.visible,
    }),
  );
  return { rows, indexByKey: indexRowsByKey(rows), revision };
}

it("keeps a departing root after the preceding subtree and removes it when its node disappears", () => {
  const tree = treeOf([
    chatNode("a", null, 5),
    chatNode("x", "a", 4),
    chatNode("y", "a", 3),
    chatNode("b", null, 2),
  ]);
  const before = presenceModel(0, tree, ["a", "b"], {
    expanded: ["a"],
    visible: new Set(["a", "x", "b"]),
  });
  const filtered = presenceModel(1, tree, ["a"], {
    expanded: ["a"],
    visible: new Set(["a", "x", "y"]),
  });
  const { result, rerender } = renderHook(
    ({ source, deleted }) =>
      useChatTreeRowPresence(
        source,
        (row) => deleted && row.nodeId === "b",
        true,
      ),
    { initialProps: { source: before, deleted: false } },
  );
  rerender({ source: filtered, deleted: false });
  expect(result.current.model.rows.map((row) => row.nodeId)).toEqual([
    "a",
    "x",
    "y",
    "b",
  ]);
  rerender({ source: filtered, deleted: true });
  expect(result.current.model.rows.map((row) => row.nodeId)).toEqual([
    "a",
    "x",
    "y",
  ]);
});

it("keeps the previous child fading if its former parent collapses after a reparent", () => {
  const roots = ["a", "b"];
  const original = treeOf([
    chatNode("a", null, 5),
    chatNode("b", null, 4),
    chatNode("moving", "a", 3),
    chatNode("stays", "a", 2),
  ]);
  const moved = treeOf([
    chatNode("a", null, 5),
    chatNode("b", null, 4),
    chatNode("moving", "b", 3),
    chatNode("stays", "a", 2),
  ]);
  const before = presenceModel(0, original, roots, {
    expanded: ["a", "b"],
    visible: null,
  });
  const movedOpen = presenceModel(1, moved, roots, {
    expanded: ["a", "b"],
    visible: null,
  });
  const { result, rerender } = renderHook(
    ({ source }) => useChatTreeRowPresence(source, () => false, true),
    { initialProps: { source: before } },
  );
  rerender({ source: movedOpen });
  const oldKey = "local:a/local:moving";
  expect(result.current.departing.has(oldKey)).toBe(true);

  rerender({
    source: presenceModel(2, moved, roots, { expanded: ["b"], visible: null }),
  });
  expect(result.current.departing.has(oldKey)).toBe(true);
  act(() => result.current.completeExit(oldKey));
  expect(result.current.model.rows.map((row) => row.key)).toEqual([
    "local:a",
    "local:b",
    "local:b/local:moving",
  ]);
});

it("drops a stale child copy when its grandparent collapses after a reparent", () => {
  const roots = ["g", "b"];
  const tree = (parentId: string): EpicTreeIndex =>
    treeOf([
      chatNode("g", null, 6),
      chatNode("b", null, 5),
      chatNode("a", "g", 4),
      chatNode("moving", parentId, 3),
      chatNode("stays", "a", 2),
    ]);
  const { result, rerender } = renderHook(
    ({ source }) => useChatTreeRowPresence(source, () => false, true),
    {
      initialProps: {
        source: presenceModel(0, tree("a"), roots, {
          expanded: ["g", "a", "b"],
          visible: null,
        }),
      },
    },
  );
  rerender({
    source: presenceModel(1, tree("b"), roots, {
      expanded: ["g", "a", "b"],
      visible: null,
    }),
  });
  expect(result.current.departing.has("local:g/local:a/local:moving")).toBe(
    true,
  );

  rerender({
    source: presenceModel(2, tree("b"), roots, {
      expanded: ["a", "b"],
      visible: null,
    }),
  });
  expect(result.current.model.rows.map((row) => row.key)).toEqual([
    "local:g",
    "local:b",
    "local:b/local:moving",
  ]);
  expect(result.current.departing.size).toBe(0);
});

function HeldRow(props: { readonly id: string | null }): ReactNode {
  // Hold exit until the real virtual list completes it or unmounts the row.
  usePresence();
  return <button type="button">{props.id}</button>;
}

function WindowedRows(props: { readonly model: ChatTreeRowModel }): ReactNode {
  const regionRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <div ref={setScrollElement}>
      <div ref={regionRef}>
        <DndContext>
          <ChatTreeVirtualList
            model={props.model}
            tabId={TAB_ID}
            scrollElement={scrollElement}
            regionRef={regionRef}
            renderRow={(row) => <HeldRow id={row.nodeId} />}
            isRowGone={() => false}
          />
        </DndContext>
      </div>
    </div>
  );
}

const WINDOW_ROOTS = Array.from(
  { length: 45 },
  (_, index) => "row-" + String(index),
);
const WINDOW_NODES = WINDOW_ROOTS.map((id, index) =>
  chatNode(id, null, 90 - index),
);

it("completes a departing family's drawn children when its parent is outside the window", () => {
  chatTreeLayout.setRowHeight(() => 30);
  chatTreeLayout.setViewport(60);
  const tree = treeOf([
    ...WINDOW_NODES,
    chatNode("parent", null, 8),
    chatNode("child", "parent", 7),
  ]);
  const roots = [
    ...WINDOW_ROOTS.slice(0, 8),
    "parent",
    ...WINDOW_ROOTS.slice(8),
  ];
  const before = presenceModel(0, tree, roots, {
    expanded: ["parent"],
    visible: null,
  });
  const { rerender } = render(<WindowedRows model={before} />);
  chatTreeLayout.scrollTo(19 * 30);

  expect(screen.queryByText("parent")).toBeNull();
  expect(screen.getByText("child")).toBeTruthy();
  rerender(
    <WindowedRows
      model={presenceModel(1, tree, WINDOW_ROOTS, {
        expanded: [],
        visible: null,
      })}
    />,
  );

  expect(screen.queryByText("child")).toBeNull();
});

it("moves focus to the visible predecessor instead of a distant pinned row when consecutive rows depart", () => {
  chatTreeLayout.setRowHeight(() => 30);
  chatTreeLayout.setViewport(90);
  const tree = treeOf(WINDOW_NODES);
  const before = presenceModel(0, tree, WINDOW_ROOTS, {
    expanded: [],
    visible: null,
  });
  const { rerender } = render(<WindowedRows model={before} />);
  chatTreeLayout.scrollTo(16 * 30);
  const outgoing = screen.getByRole("button", { name: "row-17" });
  act(() => outgoing.focus());
  expect(document.activeElement).toBe(outgoing);
  expect(screen.getByRole("button", { name: "row-44" })).toBeTruthy();

  const remaining = [...WINDOW_ROOTS.slice(0, 17), ...WINDOW_ROOTS.slice(30)];
  rerender(
    <WindowedRows
      model={presenceModel(1, tree, remaining, { expanded: [], visible: null })}
    />,
  );

  expect(document.activeElement?.getAttribute("data-row-key")).toBe(
    "local:row-16",
  );
  expect(chatTreeLayout.scrollOffset()).toBe(16 * 30);
});
