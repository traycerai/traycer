import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  TAB_ID,
  itemOf,
  mountedChatIds,
  openChatSession,
  renderChatTree,
  topOf,
  upsertChat,
  type SeedChat,
} from "./chat-tree-test-support";

/**
 * What the reader is looking at stays where it is: across a retained tab
 * hiding and showing, a folder collapsing, and rows arriving or re-sorting
 * above the viewport. The nested tree got this from the browser; the virtual
 * list has to do it itself.
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

const VIEWPORT_PX = 280;
/** A row's height plus the 2px gap above every row but the first of its group. */
const ROW_PITCH_PX = 30;
const FIRST_ROW_PX = 28;

let session: OpenedStoreForTest | null = null;

beforeEach(() => {
  chatTreeLayout.reset();
  chatTreeLayout.setViewport(VIEWPORT_PX);
});

afterEach(() => {
  cleanup();
  session?.dispose();
  session = null;
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
});

/**
 * `folder` (the newest root) holding `childCount` chats, then roots `r0..`
 * from newest to oldest - the default sort puts them in this order.
 */
function folderThenRoots(childCount: number, rootCount: number): SeedChat[] {
  const chats: SeedChat[] = [
    { id: "folder", parentId: null, updatedAt: 900_000 },
  ];
  for (let index = 0; index < childCount; index += 1) {
    chats.push({
      id: `folder-child-${index}`,
      parentId: "folder",
      updatedAt: 800_000 - index,
    });
  }
  for (let index = 0; index < rootCount; index += 1) {
    chats.push({ id: `r${index}`, parentId: null, updatedAt: 500_000 - index });
  }
  return chats;
}

function mountTree(chats: readonly SeedChat[]): OpenedStoreForTest {
  session = openChatSession(chats);
  renderChatTree(session);
  return session;
}

/** Scrolls until `rowId` is the row at the top of the viewport. */
function scrollRowToTop(rowId: string, approximateIndex: number): number {
  chatTreeLayout.scrollTo(approximateIndex * ROW_PITCH_PX);
  const top = topOf(itemOf(rowId));
  chatTreeLayout.scrollTo(top);
  return top;
}

/** The scroll requests the list has issued since `mark`, taken from `requestsMark()`. */
function requestsMark(): number {
  return chatTreeLayout.scrollRequests().length;
}

function requestsSince(mark: number): readonly number[] {
  return chatTreeLayout.scrollRequests().slice(mark);
}

/** Where the row sits relative to the top of the viewport. */
function distanceFromViewportTop(rowId: string): number {
  return topOf(itemOf(rowId)) - chatTreeLayout.scrollOffset();
}

async function applyEdit(
  handle: OpenedStoreForTest,
  edit: () => void,
): Promise<void> {
  await act(async () => {
    edit();
    await handle.flush();
  });
}

function collapse(nodeId: string): void {
  act(() => {
    useEpicSidebarExpansionStore.getState().collapse(TAB_ID, "chats", nodeId);
  });
}

describe("scroll kept across a tab switch", () => {
  const CHILDREN = 40;
  const ROOTS = 100;

  it("returns to the same offset, window and row positions after the tab hides and shows", () => {
    mountTree(folderThenRoots(CHILDREN, ROOTS));
    scrollRowToTop("r10", CHILDREN + 11);
    const offset = chatTreeLayout.scrollOffset();
    const window = mountedChatIds();
    const tops = window.map((id) => topOf(itemOf(id)));

    const mark = requestsMark();
    chatTreeLayout.hide();
    chatTreeLayout.show();

    expect(chatTreeLayout.scrollOffset()).toBe(offset);
    expect(mountedChatIds()).toEqual(window);
    expect(window.map((id) => topOf(itemOf(id)))).toEqual(tops);
    expect(requestsSince(mark)).toEqual([]);
  });

  it("returns at the hidden offset, with no anchoring scroll, when a row arrived above while hidden", async () => {
    const handle = mountTree(folderThenRoots(CHILDREN, ROOTS));
    scrollRowToTop("r10", CHILDREN + 11);
    const offset = chatTreeLayout.scrollOffset();

    const mark = requestsMark();
    chatTreeLayout.hide();
    await applyEdit(handle, () => {
      upsertChat(handle, { id: "arrived", parentId: null, updatedAt: 950_000 });
    });
    chatTreeLayout.show();

    expect(chatTreeLayout.scrollOffset()).toBe(offset);
    expect(requestsSince(mark)).toEqual([]);
  });
});

describe("scroll kept across a folder collapsing", () => {
  const CHILDREN = 40;
  const ROOTS = 100;
  const CHILDREN_HEIGHT_PX = FIRST_ROW_PX + (CHILDREN - 1) * ROW_PITCH_PX;

  it("scrolls up by exactly the height the children took when the folder sat above the viewport", () => {
    mountTree(folderThenRoots(CHILDREN, ROOTS));
    const offset = scrollRowToTop("r10", CHILDREN + 11);
    const gap = distanceFromViewportTop("r10");
    const mark = requestsMark();

    collapse("folder");

    expect(requestsSince(mark)).toEqual([offset - CHILDREN_HEIGHT_PX]);
    expect(distanceFromViewportTop("r10")).toBe(gap);
  });

  it("issues no scroll when the collapsing folder is in view", () => {
    mountTree(folderThenRoots(CHILDREN, ROOTS));
    scrollRowToTop("folder-child-0", 1);
    chatTreeLayout.scrollTo(0);
    const mark = requestsMark();

    collapse("folder");

    expect(requestsSince(mark)).toEqual([]);
    expect(chatTreeLayout.scrollOffset()).toBe(0);
  });

  it("leaves a list at its top where it is when a row arrives above", async () => {
    const handle = mountTree(folderThenRoots(CHILDREN, ROOTS));
    expect(chatTreeLayout.scrollOffset()).toBe(0);
    const mark = requestsMark();

    await applyEdit(handle, () => {
      upsertChat(handle, { id: "arrived", parentId: null, updatedAt: 950_000 });
    });

    expect(requestsSince(mark)).toEqual([]);
    expect(chatTreeLayout.scrollOffset()).toBe(0);
  });
});

describe("scroll kept when rows arrive or re-sort above the viewport", () => {
  const ROOTS = 80;

  function rootsOnly(): SeedChat[] {
    return folderThenRoots(0, ROOTS).slice(1);
  }

  it("keeps the top row in place when a new root arrives above", async () => {
    const handle = mountTree(rootsOnly());
    scrollRowToTop("r20", 20);
    const gap = distanceFromViewportTop("r20");
    const mark = requestsMark();

    await applyEdit(handle, () => {
      upsertChat(handle, { id: "arrived", parentId: null, updatedAt: 950_000 });
    });

    expect(distanceFromViewportTop("r20")).toBe(gap);
    expect(requestsSince(mark)).toHaveLength(1);
  });

  it("keeps the top row in place when the arriving row is taller than the base height and within the rendered rows", async () => {
    chatTreeLayout.setRowHeight((key, _index, estimate) =>
      key.includes("arrived") ? 56 : estimate,
    );
    const handle = mountTree(rootsOnly());
    scrollRowToTop("r8", 8);
    const gap = distanceFromViewportTop("r8");
    const offset = chatTreeLayout.scrollOffset();

    await applyEdit(handle, () => {
      upsertChat(handle, { id: "arrived", parentId: null, updatedAt: 950_000 });
    });

    expect(distanceFromViewportTop("r8")).toBe(gap);
    expect(chatTreeLayout.scrollOffset()).toBeGreaterThanOrEqual(offset + 56);
  });

  it("keeps the top row in place when a recency re-sort moves a row from below to above it", async () => {
    const handle = mountTree(rootsOnly());
    scrollRowToTop("r20", 20);
    const gap = distanceFromViewportTop("r20");
    const mark = requestsMark();

    await applyEdit(handle, () => {
      upsertChat(handle, { id: "r60", parentId: null, updatedAt: 950_000 });
    });

    expect(distanceFromViewportTop("r20")).toBe(gap);
    expect(requestsSince(mark)).toHaveLength(1);
  });
});
