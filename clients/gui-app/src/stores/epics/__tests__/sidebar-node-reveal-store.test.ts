import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearSidebarNodeRevealRequest,
  requestSidebarNodeReveal,
  SIDEBAR_NODE_REVEAL_VISIBILITY_MS,
  useSidebarNodeRevealStore,
} from "@/stores/epics/sidebar-node-reveal-store";
import { flashSidebarElement } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

beforeEach(() => {
  vi.useFakeTimers();
  useSidebarNodeRevealStore.setState(
    { requestsByViewTabId: {}, visibleByViewTabId: {} },
    true,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps a served target visible for the flash without an older timer clearing a repeat", () => {
  const element = document.createElement("div");
  requestSidebarNodeReveal("tab-1", "node-1");
  flashSidebarElement(element, 1);
  clearSidebarNodeRevealRequest("tab-1", 1);
  vi.advanceTimersByTime(1_000);

  requestSidebarNodeReveal("tab-1", "node-1");
  flashSidebarElement(element, 2);
  clearSidebarNodeRevealRequest("tab-1", 2);
  vi.advanceTimersByTime(SIDEBAR_NODE_REVEAL_VISIBILITY_MS - 1_000);

  expect(
    useSidebarNodeRevealStore.getState().visibleByViewTabId["tab-1"],
  ).toEqual({ nodeId: "node-1", nonce: 2 });
  expect(element.dataset.sidebarRevealHighlighted).toBe("true");

  vi.advanceTimersByTime(1_000);
  expect(
    useSidebarNodeRevealStore.getState().visibleByViewTabId["tab-1"],
  ).toBeUndefined();
  expect(element.dataset.sidebarRevealHighlighted).toBeUndefined();
});
