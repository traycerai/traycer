import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearSidebarNodeRevealRequest,
  requestSidebarNodeReveal,
  SIDEBAR_NODE_REVEAL_VISIBILITY_MS,
  useSidebarNodeRevealStore,
} from "@/stores/epics/sidebar-node-reveal-store";

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
  requestSidebarNodeReveal("tab-1", "node-1");
  clearSidebarNodeRevealRequest("tab-1", 1);
  vi.advanceTimersByTime(1_000);

  requestSidebarNodeReveal("tab-1", "node-1");
  clearSidebarNodeRevealRequest("tab-1", 1);
  vi.advanceTimersByTime(SIDEBAR_NODE_REVEAL_VISIBILITY_MS - 1_000);

  expect(
    useSidebarNodeRevealStore.getState().visibleByViewTabId["tab-1"],
  ).toEqual({ nodeId: "node-1", nonce: 1 });

  vi.advanceTimersByTime(1_000);
  expect(
    useSidebarNodeRevealStore.getState().visibleByViewTabId["tab-1"],
  ).toBeUndefined();
});
