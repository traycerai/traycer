import { describe, expect, it } from "vitest";
import {
  RETAINED_PANE_CHAT_CAP,
  retainedPaneChatInstanceIds,
} from "@/stores/epics/canvas/retained-pane-chats";
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";

function paneWith(input: {
  readonly tabInstanceIds: ReadonlyArray<string>;
  readonly activeTabId: string | null;
  readonly activationHistory: ReadonlyArray<string>;
}): TilePane {
  return {
    kind: "pane",
    id: "p1",
    tabInstanceIds: input.tabInstanceIds,
    activeTabId: input.activeTabId,
    previewTabId: null,
    activationHistory: input.activationHistory,
  };
}

/** Everything whose id starts with `chat-` resolves to a chat tile. */
function tileFor(instanceId: string): EpicCanvasTileRef | undefined {
  if (!instanceId.startsWith("chat-") && !instanceId.startsWith("spec-")) {
    return undefined;
  }
  return {
    id: instanceId,
    instanceId,
    type: instanceId.startsWith("chat-") ? "chat" : "spec",
    name: instanceId,
    hostId: "host-A",
  };
}

function retained(pane: TilePane, cap: number): ReadonlyArray<string> {
  return retainedPaneChatInstanceIds({ pane, tileFor, cap });
}

describe("retainedPaneChatInstanceIds", () => {
  it("puts the pane's active chat at the head", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a", "chat-b"],
      activeTabId: "chat-b",
      activationHistory: ["chat-b", "chat-a"],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual([
      "chat-b",
      "chat-a",
    ]);
  });

  it("retains the chat the reader came from", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a", "chat-b"],
      activeTabId: "chat-a",
      activationHistory: ["chat-a", "chat-b"],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toContain("chat-b");
  });

  it("retains chats sitting under a non-chat active tab", () => {
    // The filmed case: an artifact covers the chat in the same pane, and
    // closing it must not have cost the chat its body.
    const pane = paneWith({
      tabInstanceIds: ["spec-1", "chat-a", "chat-b"],
      activeTabId: "spec-1",
      activationHistory: ["spec-1", "chat-a", "chat-b"],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual([
      "chat-a",
      "chat-b",
    ]);
  });

  it("excludes a chat the pane has never activated", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a", "chat-never"],
      activeTabId: "chat-a",
      activationHistory: ["chat-a"],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual(["chat-a"]);
  });

  it("enforces the cap in activation order", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a", "chat-b", "chat-c"],
      activeTabId: "chat-a",
      activationHistory: ["chat-a", "chat-b", "chat-c"],
    });
    expect(retained(pane, 2)).toEqual(["chat-a", "chat-b"]);
    expect(retained(pane, 1)).toEqual(["chat-a"]);
  });

  it("never drops the tab the pane actually shows, even at cap 0", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a", "chat-b"],
      activeTabId: "chat-a",
      activationHistory: ["chat-a", "chat-b"],
    });
    expect(retained(pane, 0)).toEqual(["chat-a"]);
  });

  it("follows resolveActivePaneTab's fallback when activeTabId is stale", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a"],
      activeTabId: "gone",
      activationHistory: [],
    });
    // The fallback tab has no activation record, so only the shown-tab seed
    // can rescue it - which is exactly why the seed is not read off
    // `activationHistory[0]`.
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual(["chat-a"]);
  });

  it("ignores history entries for tabs the pane no longer holds", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a"],
      activeTabId: "chat-a",
      activationHistory: ["chat-a", "chat-closed"],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual(["chat-a"]);
  });

  it("never repeats an instance that is both shown and first in history", () => {
    const pane = paneWith({
      tabInstanceIds: ["chat-a", "chat-b"],
      activeTabId: "chat-a",
      activationHistory: ["chat-a", "chat-a", "chat-b"],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual([
      "chat-a",
      "chat-b",
    ]);
  });

  it("returns nothing for an empty pane", () => {
    const pane = paneWith({
      tabInstanceIds: [],
      activeTabId: null,
      activationHistory: [],
    });
    expect(retained(pane, RETAINED_PANE_CHAT_CAP)).toEqual([]);
  });
});
