import "../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  MOUNTED_PANE_TAB_LRU_CAP,
  useMountedPaneTabs,
} from "@/components/epic-canvas/canvas/use-mounted-pane-tabs";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

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

function renderMounted(initial: HookProps) {
  return renderHook((props: HookProps) => useMountedPaneTabs(props), {
    initialProps: initial,
  });
}

describe("useMountedPaneTabs", () => {
  it("mounts a newly active tab in the same render and keeps recent tabs up to the cap", () => {
    const tabs = [chatTab(1), chatTab(2), chatTab(3), chatTab(4)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    expect([...result.current]).toEqual(["inst-chat-1"]);

    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-chat-2", "inst-chat-1"]);

    rerender({ activeTabId: "inst-chat-3", tabs, paneVisible: true });
    expect([...result.current]).toEqual([
      "inst-chat-3",
      "inst-chat-2",
      "inst-chat-1",
    ]);

    // Fourth visit evicts the least recently active tab - cap holds.
    rerender({ activeTabId: "inst-chat-4", tabs, paneVisible: true });
    expect(result.current.size).toBe(MOUNTED_PANE_TAB_LRU_CAP);
    expect([...result.current]).toEqual([
      "inst-chat-4",
      "inst-chat-3",
      "inst-chat-2",
    ]);
  });

  it("re-activating a kept-alive tab promotes it without growing the set", () => {
    const tabs = [chatTab(1), chatTab(2), chatTab(3)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-chat-1", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-chat-1", "inst-chat-2"]);
  });

  it("pins terminal surfaces: always mounted, never evicted, never costing an LRU slot", () => {
    const tabs = [
      TERMINAL,
      TERMINAL_AGENT,
      chatTab(1),
      chatTab(2),
      chatTab(3),
      chatTab(4),
    ];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    // Terminals are mounted even though they were never active.
    expect(result.current.has("inst-term-1")).toBe(true);
    expect(result.current.has("inst-agent-1")).toBe(true);

    // Churn through every chat - the cap applies to chats only and the
    // terminals survive the whole cycle.
    for (const active of [
      "inst-chat-2",
      "inst-chat-3",
      "inst-chat-4",
      "inst-term-1",
      "inst-chat-1",
    ]) {
      rerender({ activeTabId: active, tabs, paneVisible: true });
      expect(result.current.has("inst-term-1")).toBe(true);
      expect(result.current.has("inst-agent-1")).toBe(true);
    }
    const mountedChats = [...result.current].filter((id) =>
      id.startsWith("inst-chat-"),
    );
    expect(mountedChats.length).toBe(MOUNTED_PANE_TAB_LRU_CAP);
  });

  it("activating a terminal keeps the recent non-terminal tabs mounted", () => {
    const tabs = [TERMINAL, chatTab(1), chatTab(2)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-term-1", tabs, paneVisible: true });
    expect(result.current.has("inst-term-1")).toBe(true);
    expect(result.current.has("inst-chat-2")).toBe(true);
    expect(result.current.has("inst-chat-1")).toBe(true);
  });

  it("drops closed tabs from the mounted set", () => {
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
    expect(result.current.has("inst-chat-1")).toBe(false);
    expect([...result.current]).toEqual(["inst-chat-2"]);
  });

  it("collapses a hidden pane to the active tab (+terminals) and rebuilds on visible", () => {
    const tabs = [TERMINAL, chatTab(1), chatTab(2), chatTab(3)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
      tabs,
      paneVisible: true,
    });
    rerender({ activeTabId: "inst-chat-2", tabs, paneVisible: true });
    rerender({ activeTabId: "inst-chat-3", tabs, paneVisible: true });
    expect(result.current.size).toBe(4); // 3 chats + pinned terminal

    // Pane goes to the background: only the active chat + terminal remain.
    rerender({ activeTabId: "inst-chat-3", tabs, paneVisible: false });
    expect([...result.current]).toEqual(["inst-chat-3", "inst-term-1"]);

    // Back to visible: history was dropped, the set rebuilds from revisits.
    rerender({ activeTabId: "inst-chat-3", tabs, paneVisible: true });
    expect([...result.current]).toEqual(["inst-chat-3", "inst-term-1"]);
    rerender({ activeTabId: "inst-chat-1", tabs, paneVisible: true });
    expect([...result.current]).toEqual([
      "inst-chat-1",
      "inst-chat-3",
      "inst-term-1",
    ]);
  });

  it("a hidden pane whose active tab is a terminal mounts terminals only", () => {
    const tabs = [TERMINAL, chatTab(1)];
    const { result, rerender } = renderMounted({
      activeTabId: "inst-chat-1",
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
});
