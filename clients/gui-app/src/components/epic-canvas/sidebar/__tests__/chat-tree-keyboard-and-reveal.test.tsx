import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import {
  SidebarBulkSelectionProvider,
  useSidebarBulkSelection,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import {
  panelHeaderSearchSurfaceKey,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import {
  requestSidebarNodeReveal,
  useSidebarNodeRevealStore,
} from "@/stores/epics/sidebar-node-reveal-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { setCloudChats } from "./chat-tree-host-mocks";
import {
  EPIC_ID,
  TAB_ID,
  openChatSession,
  rootChats,
  type SeedChat,
} from "./chat-tree-test-support";
import { cloudSummary } from "./chat-tree-row-fixtures";

/**
 * Moving through the virtualised chat tree by keyboard and screen reader, and
 * revealing a row that is not drawn. Only a window of the rows is in the DOM:
 * Tab, Shift+Tab, focus, rename, menus, selection and reveal all have to work
 * for the rows outside it as they did when every row was drawn.
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

const tileNavigation = vi.hoisted(() => ({
  openTile: vi.fn((_intent: TileOpenIntent) => undefined),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigation,
}));

/** The tile the tab shows. The real store has no tab here to read it from. */
const activeTile = vi.hoisted(() => ({ artifactId: null as string | null }));
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/epics/canvas/store")>()),
  useIsActiveEpicArtifact: (_tabId: string, artifactId: string) =>
    activeTile.artifactId === artifactId,
}));

const VIEWPORT_PX = 280;
const ALL_ROWS_VIEWPORT_PX = 100_000;
const ROOT_COUNT = 60;
/** The window with this offset holds roots c20..c49 (overscan 10 either side). */
const MIDDLE_OFFSET_PX = 900;

let session: OpenedStoreForTest | null = null;

beforeEach(() => {
  chatTreeLayout.reset();
  chatTreeLayout.setViewport(VIEWPORT_PX);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  session?.dispose();
  session = null;
  tileNavigation.openTile.mockClear();
  activeTile.artifactId = null;
  setCloudChats([]);
  useSidebarNodeRevealStore.setState({
    requestsByViewTabId: {},
    visibleByViewTabId: {},
  });
  useEpicCanvasStore.setState({ pendingRootCreatesByEpic: {} });
  usePanelHeaderSearchStore.getState().closeSearch(TAB_ID, "chats");
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
});

function SelectionProbe() {
  const selection = useSidebarBulkSelection();
  return (
    <div>
      <button type="button" onClick={selection.enterSelectionMode}>
        Enter selection mode
      </button>
      <button type="button" onClick={selection.selectAllVisible}>
        Select every row
      </button>
      <output data-testid="selected-count">{selection.selectedCount}</output>
    </div>
  );
}

/** The panel between a focusable element before it and one after it. */
function mountTree(chats: readonly SeedChat[]): void {
  session = openChatSession(chats);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={session}>
        <DndContext sensors={[]}>
          <SidebarBulkSelectionProvider panelId="chats">
            <SelectionProbe />
            <button type="button">Before the tree</button>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
            <button type="button">After the tree</button>
          </SidebarBulkSelectionProvider>
        </DndContext>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
}

function items(): HTMLElement[] {
  return Array.from(
    screen
      .getByRole("tree")
      .querySelectorAll<HTMLElement>(':scope > [role="treeitem"]'),
  );
}

function itemByKey(rowKey: string): HTMLElement | null {
  return items().find((item) => item.dataset.rowKey === rowKey) ?? null;
}

function rowKeyOf(element: Element | null): string | null {
  return (
    element?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? null
  );
}

/** What Tab stops at inside a row, in DOM order. */
function tabStops(item: HTMLElement): HTMLElement[] {
  return Array.from(
    item.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]"),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("tabindex") !== "-1",
  );
}

function focusedElement(): HTMLElement {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) throw new Error("nothing is focused");
  return element;
}

function rowButton(chatId: string): HTMLElement {
  return screen.getByTestId(`epic-sidebar-item-${chatId}`);
}

function moreButton(chatId: string): HTMLElement {
  return screen.getByTestId(`epic-sidebar-more-${chatId}`);
}

function mountedChatIds(): string[] {
  return items().map((item) => {
    const id = item
      .querySelector("[data-sidebar-node-id]")
      ?.getAttribute("data-sidebar-node-id");
    if (id === null || id === undefined)
      throw new Error("a row has no node id");
    return id;
  });
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("expected a value");
  return value;
}

function focus(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

function setup(): UserEvent {
  return userEvent.setup();
}

describe("Tab and Shift+Tab across the window", () => {
  it("lands on the first row from above the tree while the list is scrolled to the middle", async () => {
    mountTree(rootChats(ROOT_COUNT));
    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX);
    expect(screen.queryByTestId("epic-sidebar-item-c1")).toBeNull();
    const user = setup();
    focus(screen.getByRole("button", { name: "Before the tree" }));

    await user.tab();

    expect(itemByKey("local:c0")).not.toBeNull();
    expect(rowKeyOf(focusedElement())).toBe("local:c0");
    expect(focusedElement()).toBe(rowButton("c0"));
  });

  it("lands on the last row's last control from below the tree while the list is scrolled to the middle", async () => {
    mountTree(rootChats(ROOT_COUNT));
    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX);
    expect(screen.queryByTestId("epic-sidebar-item-c58")).toBeNull();
    const user = setup();
    focus(screen.getByRole("button", { name: "After the tree" }));

    await user.tab({ shift: true });

    const last = itemByKey(`local:c${ROOT_COUNT - 1}`);
    expect(last).not.toBeNull();
    expect(rowKeyOf(focusedElement())).toBe(`local:c${ROOT_COUNT - 1}`);
    expect(focusedElement()).toBe(tabStops(must(last)).at(-1));
  });
});

describe("a focused row that scrolls out", () => {
  it("stays mounted and focused after the window moves far away", async () => {
    mountTree(rootChats(ROOT_COUNT));
    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX);
    const button = rowButton("c30");
    focus(button);
    // Focus also opens the row's hover card, whose hold would keep the row
    // without the focus pin. Escape closes it and leaves focus on the row.
    await setup().keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("hover-card-content")).toBeNull();
    });

    chatTreeLayout.scrollTo(0);

    expect(mountedChatIds()).toContain("c30");
    expect(document.contains(button)).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("is followed by Tab through its own controls and then to the next row", async () => {
    mountTree(rootChats(ROOT_COUNT));
    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX);
    const user = setup();
    focus(rowButton("c30"));
    chatTreeLayout.scrollTo(0);
    const ownStops = tabStops(must(itemByKey("local:c30")));
    expect(ownStops.length).toBeGreaterThan(1);

    const visited: HTMLElement[] = [];
    for (let step = 1; step < ownStops.length; step += 1) {
      await user.tab();
      visited.push(focusedElement());
    }
    expect(visited).toEqual(ownStops.slice(1));

    await user.tab();

    expect(rowKeyOf(focusedElement())).toBe("local:c31");
    expect(focusedElement()).toBe(rowButton("c31"));
  });

  it("is followed by Shift+Tab to the previous row's last control", async () => {
    mountTree(rootChats(ROOT_COUNT));
    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX);
    const user = setup();
    focus(rowButton("c30"));
    chatTreeLayout.scrollTo(0);

    await user.tab({ shift: true });

    expect(rowKeyOf(focusedElement())).toBe("local:c29");
    expect(focusedElement()).toBe(
      tabStops(must(itemByKey("local:c29"))).at(-1),
    );
  });
});

interface Aria {
  readonly level: string | null;
  readonly pos: string | null;
  readonly size: string | null;
  readonly expanded: string | null;
  readonly selected: string | null;
}

function ariaOf(testId: string): Aria {
  const item = must(
    screen.getByTestId(testId).closest<HTMLElement>('[role="treeitem"]'),
  );
  return {
    level: item.getAttribute("aria-level"),
    pos: item.getAttribute("aria-posinset"),
    size: item.getAttribute("aria-setsize"),
    expanded: item.getAttribute("aria-expanded"),
    selected: item.getAttribute("aria-selected"),
  };
}

const LOCAL_ROOTS: SeedChat[] = [
  { id: "r0", parentId: null, updatedAt: 900_000 },
  { id: "k0", parentId: "r0", updatedAt: 800_000 },
  { id: "k1", parentId: "r0", updatedAt: 700_000 },
  { id: "r1", parentId: null, updatedAt: 600_000 },
  { id: "r2", parentId: null, updatedAt: 500_000 },
];

function mixedTree(): void {
  setCloudChats([
    cloudSummary("cl0", null, "cl0"),
    cloudSummary("cc0", "cl0", "cc0"),
    cloudSummary("cc1", "cl0", "cc1"),
    cloudSummary("cl1", null, "cl1"),
  ]);
  useEpicCanvasStore.setState({
    pendingRootCreatesByEpic: { [EPIC_ID]: [{ id: "pending-1", name: "New" }] },
  });
  chatTreeLayout.setViewport(ALL_ROWS_VIEWPORT_PX);
  mountTree(LOCAL_ROOTS);
}

describe("screen reader structure of the rendered rows", () => {
  it("numbers interleaved local, cloud and pending roots as one set of six at level 1", () => {
    mixedTree();
    const roots = items().filter(
      (item) => item.getAttribute("aria-level") === "1",
    );
    expect(roots).toHaveLength(6);
    expect(roots.map((item) => item.getAttribute("aria-posinset"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(roots.map((item) => item.getAttribute("aria-setsize"))).toEqual(
      Array(6).fill("6"),
    );
    expect(
      roots
        .at(-1)
        ?.querySelector("[data-testid='epic-sidebar-pending-create']"),
    ).not.toBeNull();
  });

  it("numbers a nested local child group by position within its parent, one level deeper", () => {
    mixedTree();
    expect(ariaOf("epic-sidebar-item-k0")).toMatchObject({
      level: "2",
      pos: "1",
      size: "2",
    });
    expect(ariaOf("epic-sidebar-item-k1")).toMatchObject({
      level: "2",
      pos: "2",
      size: "2",
    });
  });

  it("numbers a cloud child group by position within its parent, one level deeper", () => {
    mixedTree();
    expect(ariaOf("epic-sidebar-cloud-item-cc0")).toMatchObject({
      level: "2",
      pos: "1",
      size: "2",
    });
    expect(ariaOf("epic-sidebar-cloud-item-cc1")).toMatchObject({
      level: "2",
      pos: "2",
      size: "2",
    });
  });

  it("sets aria-expanded on branches only, and flips it when a branch collapses", () => {
    mixedTree();
    expect(ariaOf("epic-sidebar-item-r0").expanded).toBe("true");
    expect(ariaOf("epic-sidebar-cloud-item-cl0").expanded).toBe("true");
    expect(ariaOf("epic-sidebar-item-r1").expanded).toBeNull();
    expect(ariaOf("epic-sidebar-item-k0").expanded).toBeNull();
    expect(ariaOf("epic-sidebar-cloud-item-cl1").expanded).toBeNull();

    act(() => {
      useEpicSidebarExpansionStore.getState().collapse(TAB_ID, "chats", "r0");
    });

    expect(ariaOf("epic-sidebar-item-r0").expanded).toBe("false");
    expect(screen.queryByTestId("epic-sidebar-item-k0")).toBeNull();
  });

  it("marks only the row whose tile is active as selected", () => {
    activeTile.artifactId = "r1";
    mixedTree();
    expect(ariaOf("epic-sidebar-item-r1").selected).toBe("true");
    expect(ariaOf("epic-sidebar-item-r0").selected).toBe("false");
    expect(ariaOf("epic-sidebar-item-k0").selected).toBe("false");
  });
});

function revealNode(nodeId: string): void {
  act(() => {
    requestSidebarNodeReveal(TAB_ID, nodeId);
  });
}

function pendingRequest(): unknown {
  return useSidebarNodeRevealStore.getState().requestsByViewTabId[TAB_ID];
}

function highlighted(testId: string): boolean {
  return screen.getByTestId(testId).dataset.sidebarRevealHighlighted === "true";
}

describe("reveal of a row outside the window", () => {
  it("scrolls to a local root far below, renders it, flashes it and clears the request", async () => {
    mountTree(rootChats(ROOT_COUNT));
    expect(screen.queryByTestId("epic-sidebar-item-c45")).toBeNull();
    const before = chatTreeLayout.scrollOffset();

    revealNode("c45");

    await waitFor(() => {
      expect(highlighted("epic-sidebar-item-c45")).toBe(true);
    });
    expect(pendingRequest()).toBeUndefined();
    expect(chatTreeLayout.scrollOffset()).not.toBe(before);
  });

  it("scrolls to a cloud row far below and flashes it by its chat id", async () => {
    setCloudChats(
      ["cl-a", "cl-b", "cl-c", "cl-d"].map((id) => cloudSummary(id, null, id)),
    );
    mountTree(rootChats(ROOT_COUNT));
    const target = must(
      ["cl-a", "cl-b", "cl-c", "cl-d"].find(
        (id) => screen.queryByTestId(`epic-sidebar-cloud-item-${id}`) === null,
      ),
    );
    const before = chatTreeLayout.scrollOffset();

    revealNode(target);

    await waitFor(() => {
      expect(highlighted(`epic-sidebar-cloud-item-${target}`)).toBe(true);
    });
    expect(pendingRequest()).toBeUndefined();
    expect(chatTreeLayout.scrollOffset()).not.toBe(before);
  });

  it("expands a collapsed ancestor, then reveals and flashes the off-screen nested row", async () => {
    const chats: SeedChat[] = [{ id: "f", parentId: null, updatedAt: 900_000 }];
    for (let index = 0; index < 40; index += 1) {
      chats.push({
        id: `f${index}`,
        parentId: "f",
        updatedAt: 800_000 - index,
      });
    }
    chats.push(...rootChats(ROOT_COUNT));
    mountTree(chats);
    act(() => {
      useEpicSidebarExpansionStore.getState().collapse(TAB_ID, "chats", "f");
    });
    chatTreeLayout.scrollTo(1800);
    expect(screen.queryByTestId("epic-sidebar-item-f39")).toBeNull();

    revealNode("f39");

    await waitFor(() => {
      expect(highlighted("epic-sidebar-item-f39")).toBe(true);
    });
    expect(ariaOf("epic-sidebar-item-f").expanded).toBe("true");
    expect(chatTreeLayout.scrollOffset()).toBeLessThan(1800);
    expect(pendingRequest()).toBeUndefined();
  });

  it("waits while the tab is hidden and reveals once it shows", async () => {
    mountTree(rootChats(ROOT_COUNT));
    chatTreeLayout.hide();

    revealNode("c45");

    expect(pendingRequest()).toBeDefined();
    expect(screen.queryByTestId("epic-sidebar-item-c45")).toBeNull();
    expect(
      document.querySelector("[data-sidebar-reveal-highlighted]"),
    ).toBeNull();

    chatTreeLayout.show();

    await waitFor(() => {
      expect(highlighted("epic-sidebar-item-c45")).toBe(true);
    });
    expect(pendingRequest()).toBeUndefined();
  });
});

describe("selection mode across the window", () => {
  it("moves Tab from a focused checkbox to the next row's checkbox across the window edge", async () => {
    mountTree(rootChats(ROOT_COUNT));
    act(() => {
      screen.getByRole("button", { name: "Enter selection mode" }).click();
    });
    const edge = mountedChatIds()
      .filter((id) => id !== "c59")
      .at(-1);
    expect(edge).toBe("c19");
    const user = setup();
    focus(screen.getByTestId("epic-sidebar-select-c19"));

    await user.tab();

    expect(document.activeElement).toBe(
      screen.getByTestId("epic-sidebar-select-c20"),
    );
  });

  it("selects every selectable row, the unrendered ones included", () => {
    mountTree(rootChats(ROOT_COUNT));
    act(() => {
      screen.getByRole("button", { name: "Enter selection mode" }).click();
    });
    expect(mountedChatIds().length).toBeLessThan(ROOT_COUNT);

    act(() => {
      screen.getByRole("button", { name: "Select every row" }).click();
    });

    expect(screen.getByTestId("selected-count").textContent).toBe(
      String(ROOT_COUNT),
    );
  });
});

describe("keyboard actions on rows reached across the window", () => {
  // No dnd sensors: dnd-kit's keyboard sensor takes Enter on a draggable row for
  // a drag, which is not what this checks.
  it("opens its tile when a row button reached by Tab across the window edge is activated", async () => {
    mountTree(rootChats(ROOT_COUNT));
    const user = setup();
    focus(rowButton("c19"));
    for (
      let step = 0;
      step < 8 && rowKeyOf(document.activeElement) !== "local:c20";
      step += 1
    ) {
      await user.tab();
    }
    expect(focusedElement()).toBe(rowButton("c20"));

    await user.keyboard("{Enter}");

    expect(tileNavigation.openTile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tileNavigation.openTile.mock.calls[0])).toContain(
      "c20",
    );
  });

  it("opens the panel search seeded with a printable key typed on a row button", async () => {
    mountTree(rootChats(ROOT_COUNT));
    const user = setup();
    focus(rowButton("c3"));

    await user.keyboard("x");

    const key = panelHeaderSearchSurfaceKey(TAB_ID, "chats");
    const search = usePanelHeaderSearchStore.getState();
    expect(search.openBySurfaceKey[key]).toBe(true);
    expect(search.queryBySurfaceKey[key]).toBe("x");
  });
});

describe("a row's own state survives the window moving", () => {
  it("keeps a row in rename mode mounted with its input focused", async () => {
    mountTree(rootChats(ROOT_COUNT));
    const user = setup();
    await user.click(moreButton("c5"));
    await user.click(await screen.findByTestId("epic-sidebar-rename-c5"));
    const input = await screen.findByTestId("epic-sidebar-rename-input-c5");
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX + 400);

    expect(mountedChatIds()).toContain("c5");
    expect(screen.getByTestId("epic-sidebar-rename-input-c5")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("returns focus to the row's more button on Escape after the window moved away", async () => {
    mountTree(rootChats(ROOT_COUNT));
    const user = setup();
    focus(moreButton("c5"));
    await user.keyboard("{Enter}");
    await screen.findByTestId("epic-sidebar-rename-c5");

    chatTreeLayout.scrollTo(MIDDLE_OFFSET_PX + 400);
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByTestId("epic-sidebar-rename-c5")).toBeNull();
    });
    expect(mountedChatIds()).toContain("c5");
    expect(document.activeElement).toBe(moreButton("c5"));
  });
});
