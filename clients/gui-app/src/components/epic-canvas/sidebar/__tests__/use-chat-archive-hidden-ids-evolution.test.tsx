/**
 * `useChatArchiveHiddenIds`' reveal exception against an identity evolution
 * chat, on a minimal tree: conversation -> evolution pass -> ordinary child.
 *
 * The default view hides the pass and its subtree (it is folded into the
 * archive partition). An active child must not pull the pass back into view -
 * the reveal walks a candidate's ancestors - while the user opening the pass
 * in a tile still reveals it.
 *
 * Only the hook's store reads are stubbed (tree, activity tiers, evolution ids,
 * open tiles, the base archive-hidden set); the reveal itself is the real one.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityTier, EpicTreeIndex } from "@/lib/epic-selectors";
import type { TreeNode } from "@/stores/epics/open-epic/types";
import { EMPTY_INDICATOR_STATE_RESPONSE } from "@/stores/notifications/notification-indicator-state";
import { useChatArchiveHiddenIds } from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";

const EPIC_ID = "epic-evolution-reveal";
const CONVO = "chat-convo";
const EVOLUTION = "chat-evolution";
const CHILD = "chat-child";

function node(id: string, parentId: string | null): TreeNode {
  return {
    id,
    parentId,
    title: id,
    type: "chat",
    status: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const TREE: EpicTreeIndex = {
  rootIds: [CONVO],
  childrenByParent: { [CONVO]: [EVOLUTION], [EVOLUTION]: [CHILD] },
  nodeById: {
    [CONVO]: node(CONVO, null),
    [EVOLUTION]: node(EVOLUTION, CONVO),
    [CHILD]: node(CHILD, EVOLUTION),
  },
};

const state = vi.hoisted(() => ({
  openTileContentIds: new Set<string>(),
  activityTiers: new Map<string, "turn" | "background">(),
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicTreeIndex: () => TREE,
  useEpicAgentActivityTiers: (): ReadonlyMap<string, AgentActivityTier> =>
    state.activityTiers,
  useEpicEvolutionChatIds: () => [EVOLUTION],
}));

vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/epics/canvas/store")>()),
  useOpenTileContentIds: () => state.openTileContentIds,
}));

// What the real `useSidebarArchiveHiddenIds` answers in the default view for
// this tree: the pass is an archive root, so it and its subtree are hidden.
vi.mock(
  "@/components/epic-canvas/sidebar/epic-sidebar-selection",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/sidebar/epic-sidebar-selection")
    >()),
    useSidebarArchiveHiddenIds: () => new Set([EVOLUTION, CHILD]),
  }),
);

function renderHidden(): ReadonlySet<string> {
  const { result } = renderHook(() =>
    useChatArchiveHiddenIds({
      epicId: EPIC_ID,
      tabId: "tab-1",
      chatIds: [CONVO, EVOLUTION, CHILD],
      notificationIndicators: EMPTY_INDICATOR_STATE_RESPONSE,
    }),
  );
  return result.current;
}

beforeEach(() => {
  state.openTileContentIds = new Set();
  state.activityTiers = new Map([[CHILD, "turn"]]);
});

afterEach(() => {
  cleanup();
});

describe("useChatArchiveHiddenIds - evolution chats", () => {
  it("keeps the evolution pass hidden when only an ordinary child under it is active", () => {
    const hidden = renderHidden();

    expect(hidden.has(EVOLUTION)).toBe(true);
    expect(hidden.has(CHILD)).toBe(true);
  });

  it("reveals the evolution pass when the user has it open in a tile", () => {
    state.openTileContentIds = new Set([EVOLUTION]);

    const hidden = renderHidden();

    expect(hidden.has(EVOLUTION)).toBe(false);
  });
});
