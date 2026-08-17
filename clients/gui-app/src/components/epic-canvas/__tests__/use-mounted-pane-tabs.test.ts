import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  MOUNTED_PANE_TAB_LRU_CAP,
  useMountedPaneTabs,
  type UseMountedPaneTabsInput,
} from "@/components/epic-canvas/canvas/use-mounted-pane-tabs";
import { RETAINED_PANE_CHAT_CAP } from "@/stores/epics/canvas/retained-pane-chats";
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";

/** A generic LRU-eligible (non-terminal, non-chat) tab kind. */
function specTab(n: number): EpicCanvasTileRef {
  return {
    id: `spec-${n}`,
    instanceId: `inst-spec-${n}`,
    type: "spec",
    name: `Spec ${n}`,
    hostId: "host-A",
  };
}

function chatTab(n: number): EpicCanvasTileRef {
  return {
    id: `chat-${n}`,
    instanceId: `inst-chat-${n}`,
    type: "chat",
    name: `Chat ${n}`,
    hostId: "host-A",
  };
}

const TERMINAL: EpicCanvasTileRef = {
  id: "term-1",
  instanceId: "inst-term-1",
  type: "terminal",
  name: "Terminal",
  titleSource: "manual",
  hostId: "host-A",
  cwd: "/work/repo",
};

const TERMINAL_AGENT: EpicCanvasTileRef = {
  id: "agent-1",
  instanceId: "inst-agent-1",
  type: "terminal-agent",
  name: "Codex",
  hostId: "host-A",
};

interface HookProps {
  readonly activeTabId: string | null;
  readonly tabs: ReadonlyArray<EpicCanvasTileRef>;
  readonly paneVisible: boolean;
}

/**
 * The pane's `activationHistory` is real store state, so the driver below
 * maintains it exactly as the store does rather than letting each test
 * hand-author one: `recordPaneActivation` unshifts the newly activated tab
 * (dropping its earlier entry), and `reconcileCanvasInvariants` prunes
 * anything no longer open. Chat retention reads that history, so a test that
 * faked it would be asserting against a shape production never produces.
 */
function renderMounted(initial: HookProps) {
  let activationHistory: ReadonlyArray<string> = [];

  const build = (props: HookProps): UseMountedPaneTabsInput => {
    const live = new Set(props.tabs.map((tab) => tab.instanceId));
    const activated =
      props.activeTabId === null
        ? activationHistory
        : [
            props.activeTabId,
            ...activationHistory.filter((id) => id !== props.activeTabId),
          ];
    activationHistory = activated.filter((id) => live.has(id));
    const pane: TilePane = {
      kind: "pane",
      id: "pane-1",
      tabInstanceIds: props.tabs.map((tab) => tab.instanceId),
      activeTabId: props.activeTabId,
      previewTabId: null,
      activationHistory,
    };
    return {
      activeTabId: props.activeTabId,
      pane,
      tabs: props.tabs,
      paneVisible: props.paneVisible,
    };
  };

  const hook = renderHook(
    (props: UseMountedPaneTabsInput) => useMountedPaneTabs(props),
    { initialProps: build(initial) },
  );
  return {
    result: hook.result,
    rerender: (props: HookProps): void => {
      hook.rerender(build(props));
    },
  };
}

describe("useMountedPaneTabs", () => {
  it("mounts a newly active tab in the same render and keeps recent tabs up to the cap", () => {
    const tabs = [specTab(1), specTab(2), specTab(3), specTab(4)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    expect([...result.current]).toEqual(["inst-spec-1"]);

    rerender({ activeTabId: "inst-spec-2", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-spec-2", "inst-spec-1"]);

    rerender({ activeTabId: "inst-spec-3", tabs, paneVisible: true });
    expect([...result.current]).toEqual([
      "inst-spec-3",
      "inst-spec-2",
      "inst-spec-1",
    ]);

    // Fourth visit evicts the least recently active tab - cap holds.
    rerender({ activeTabId: "inst-spec-4", tabs, paneVisible: true });
    expect(result.current.size).toBe(MOUNTED_PANE_TAB_LRU_CAP);
    expect([...result.current]).toEqual([
      "inst-spec-4",
      "inst-spec-3",
      "inst-spec-2",
    ]);
  });

  it("re-activating a kept-alive tab promotes it without growing the set", () => {
    const tabs = [specTab(1), specTab(2), specTab(3)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-spec-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-spec-1", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-spec-1", "inst-spec-2"]);
  });

  it("pins terminal surfaces: always mounted, never evicted, never costing an LRU slot", () => {
    const tabs = [
      TERMINAL,
      TERMINAL_AGENT,
      specTab(1),
      specTab(2),
      specTab(3),
      specTab(4),
    ];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    // Terminals are mounted even though they were never active.
    expect(result.current.has("inst-term-1")).toBe(true);
    expect(result.current.has("inst-agent-1")).toBe(true);

    // Churn through every spec - the cap applies to specs only and the
    // terminals survive the whole cycle.
    for (const active of [
      "inst-spec-2",
      "inst-spec-3",
      "inst-spec-4",
      "inst-term-1",
      "inst-spec-1",
    ]) {
      rerender({ activeTabId: active, tabs, paneVisible: true });
      expect(result.current.has("inst-term-1")).toBe(true);
      expect(result.current.has("inst-agent-1")).toBe(true);
    }
    const mountedSpecs = [...result.current].filter((id) =>
      id.startsWith("inst-spec-"),
    );
    expect(mountedSpecs.length).toBe(MOUNTED_PANE_TAB_LRU_CAP);
  });

  it("activating a terminal keeps the recent non-terminal tabs mounted", () => {
    const tabs = [TERMINAL, specTab(1), specTab(2)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-spec-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-term-1", tabs, paneVisible: true });
    expect(result.current.has("inst-term-1")).toBe(true);
    expect(result.current.has("inst-spec-2")).toBe(true);
    expect(result.current.has("inst-spec-1")).toBe(true);
  });

  it("drops closed tabs from the mounted set", () => {
    const tabs = [specTab(1), specTab(2)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-spec-2", tabs, paneVisible: true });
    expect(result.current.has("inst-spec-1")).toBe(true);

    rerender({
      activeTabId: "inst-spec-2",
      tabs: [specTab(2)],
      paneVisible: true,
    });
    expect(result.current.has("inst-spec-1")).toBe(false);
    expect([...result.current]).toEqual(["inst-spec-2"]);
  });

  it("collapses a hidden pane to the active tab (+terminals) and rebuilds on visible", () => {
    const tabs = [TERMINAL, specTab(1), specTab(2), specTab(3)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-spec-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-spec-3", tabs, paneVisible: true });
    expect(result.current.size).toBe(4); // 3 specs + pinned terminal

    // Pane goes to the background: only the active spec + terminal remain.
    rerender({ activeTabId: "inst-spec-3", tabs, paneVisible: false });
    expect([...result.current]).toEqual(["inst-spec-3", "inst-term-1"]);

    // Back to visible: history was dropped, the set rebuilds from revisits.
    rerender({ activeTabId: "inst-spec-3", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-spec-3", "inst-term-1"]);
    rerender({ activeTabId: "inst-spec-1", tabs, paneVisible: true });
    expect([...result.current]).toEqual([
      "inst-spec-1",
      "inst-spec-3",
      "inst-term-1",
    ]);
  });

  it("a hidden pane whose active tab is a terminal mounts terminals only", () => {
    const tabs = [TERMINAL, specTab(1)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-term-1", tabs, paneVisible: false });
    expect([...result.current]).toEqual(["inst-term-1"]);
  });

  it("returns an empty set for an empty pane", () => {
    const { result } = renderMounted({
      activeTabId: null,
      tabs: [],
      paneVisible: true,
    });
    expect(result.current.size).toBe(0);
  });

  it("retains a chat across a switch to another tab kind, without costing an LRU slot", () => {
    const tabs = [chatTab(1), specTab(1), specTab(2), specTab(3), specTab(4)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    expect([...result.current]).toEqual(["inst-chat-1"]);

    // The reported churn: something else takes the foreground and the chat
    // stays mounted, so returning to it is a visibility toggle.
    rerender({ activeTabId: "inst-spec-1", tabs, paneVisible: true });
    expect(result.current.has("inst-chat-1")).toBe(true);

    // It never competes with the spec LRU: four specs still evict to the cap
    // with the chat mounted alongside them.
    for (const active of ["inst-spec-2", "inst-spec-3", "inst-spec-4"]) {
      rerender({ activeTabId: active, tabs, paneVisible: true });
    }
    const mountedSpecs = [...result.current].filter((id) =>
      id.startsWith("inst-spec-"),
    );
    expect(mountedSpecs.length).toBe(MOUNTED_PANE_TAB_LRU_CAP);
    expect(result.current.has("inst-chat-1")).toBe(true);
  });

  it("retains the chat underneath when the tab covering it closes", () => {
    // The filmed regression: chat is open, a second tab is opened over it in
    // the same pane, then closed. The chat must never have unmounted.
    const tabs = [chatTab(1), specTab(1)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-spec-1", tabs, paneVisible: true });
    expect(result.current.has("inst-chat-1")).toBe(true);

    rerender({
      activeTabId: "inst-chat-1",
      tabs: [chatTab(1)],
      paneVisible: true,
    });
    expect([...result.current]).toEqual(["inst-chat-1"]);
  });

  it("retains chats up to the cap, evicting least-recently-active first", () => {
    const tabs = [chatTab(1), chatTab(2), chatTab(3)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    expect(result.current.size).toBe(RETAINED_PANE_CHAT_CAP);
    expect(result.current.has("inst-chat-1")).toBe(true);

    // A third chat pushes the oldest past the cap - that one, and only that
    // one, pays a real remount on the way back.
    rerender({ activeTabId: "inst-chat-3", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-chat-3", "inst-chat-2"]);
  });

  it("drops a closed chat from the retained set", () => {
    const tabs = [chatTab(1), chatTab(2)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    expect(result.current.has("inst-chat-1")).toBe(true);

    rerender({
      activeTabId: "inst-chat-2",
      tabs: [chatTab(2)],
      paneVisible: true,
    });
    expect([...result.current]).toEqual(["inst-chat-2"]);
  });

  it("keeps retained chats in a hidden pane, where the spec LRU collapses", () => {
    // Retention must NOT collapse with pane visibility: membership computes
    // the same set from a store snapshot and cannot observe it, so collapsing
    // here alone would leave a member with no slot to publish its geometry.
    const tabs = [chatTab(1), chatTab(2), specTab(1), specTab(2)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-spec-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-1", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-spec-2", tabs, paneVisible: false });

    expect(result.current.has("inst-chat-1")).toBe(true);
    expect(result.current.has("inst-chat-2")).toBe(true);
    // The LRU half still collapses to the active tab alone.
    expect(result.current.has("inst-spec-1")).toBe(false);
    expect(result.current.has("inst-spec-2")).toBe(true);
  });

  it("keeps an active chat tab mounted alongside pinned terminals in a hidden pane", () => {
    const tabs = [TERMINAL, chatTab(1)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-1", tabs, paneVisible: false });
    expect([...result.current]).toEqual(["inst-term-1", "inst-chat-1"]);
  });
});
