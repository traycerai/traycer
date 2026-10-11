import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Perf fix W1-B item 4: retained-chat candidates are cached per pane node
 * (a `WeakMap`, invalidated only when that node or its `tiles` reference
 * changes). Structural sharing means selecting a tab in one pane replaces
 * only that pane and its ancestors, so a sibling pane - whether in the same
 * canvas or a different top-level tab - keeps its reference and must hit the
 * cache instead of re-walking `retainedPaneChatInstanceIds`.
 */
vi.mock("@/stores/epics/canvas/retained-pane-chats", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/epics/canvas/retained-pane-chats")
    >();
  return {
    ...actual,
    retainedPaneChatInstanceIds: vi.fn(actual.retainedPaneChatInstanceIds),
  };
});

import { retainedPaneChatInstanceIds } from "@/stores/epics/canvas/retained-pane-chats";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import {
  group,
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { resetChatRemoteDeletionRegistryForTesting } from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import { resetTileSurfaceEnvironmentRegistryForTesting } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";

function chatRef(instanceId: string) {
  return {
    id: instanceId,
    instanceId,
    type: "chat" as const,
    name: `Chat ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function seedSingleTabStrip(
  refs: ReadonlyArray<TabRef>,
  activeRef: TabRef,
): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    })),
    activeItemId: `tab:${activeRef.kind}:${activeRef.id}`,
    stripOrder: refs,
  }));
}

function resetAll(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
  resetChatRemoteDeletionRegistryForTesting();
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
}

function paneIdsRead(): ReadonlyArray<string> {
  return vi
    .mocked(retainedPaneChatInstanceIds)
    .mock.calls.map(([input]) => input.pane.id);
}

describe("collectCanvasWideRetainedChatMembership candidate cache", () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetAll();
    vi.mocked(retainedPaneChatInstanceIds).mockClear();
  });

  it("selecting a tab in one pane does not re-walk a sibling pane in the same canvas, nor a pane in a different top-level tab", () => {
    const ref1: TabRef = { kind: "epic", id: "tab-1" };
    const ref2: TabRef = { kind: "epic", id: "tab-2" };
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
        "tab-2": { tabId: "tab-2", epicId: "epic-2", name: "Epic 2" },
      },
      canvasByTabId: {
        "tab-1": {
          // p1 and p3 are siblings in the SAME canvas via a split - only p1
          // is targeted by the selection below.
          root: group("g1", "horizontal", [
            pane("p1", ["chat-1a", "chat-1b"]),
            pane("p3", ["chat-3a"]),
          ]),
          activePaneId: "p1",
          tilesByInstanceId: {
            "chat-1a": chatRef("chat-1a"),
            "chat-1b": chatRef("chat-1b"),
            "chat-3a": chatRef("chat-3a"),
          },
          sizesByGroupId: {},
        },
        "tab-2": {
          root: pane("p2", ["chat-2a"]),
          activePaneId: "p2",
          tilesByInstanceId: { "chat-2a": chatRef("chat-2a") },
          sizesByGroupId: {},
        },
      },
      openTabOrder: ["tab-1", "tab-2"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([ref1, ref2], ref1);
    seedSingleTabStrip([ref1, ref2], ref2);

    expect(getTileSurfaceMembership().has("chat-1a")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-3a")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-2a")).toBe(true);

    // Warm-up done; only what the selection below triggers matters now.
    vi.mocked(retainedPaneChatInstanceIds).mockClear();

    useEpicCanvasStore.getState().setActiveTileTab("tab-1", "p1", "chat-1b");

    const touchedPaneIds = paneIdsRead();
    expect(touchedPaneIds).toContain("p1");
    expect(touchedPaneIds).not.toContain("p3");
    expect(touchedPaneIds).not.toContain("p2");
    expect(getTileSurfaceMembership().has("chat-1b")).toBe(true);
  });
});
