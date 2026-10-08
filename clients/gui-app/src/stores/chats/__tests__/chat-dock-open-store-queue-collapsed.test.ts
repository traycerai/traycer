import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useChatDockOpenStore } from "@/stores/chats/chat-dock-open-store";

function reset(): void {
  useChatDockOpenStore.setState({
    openByChatId: new Map(),
    queueCollapsedByChatId: new Map(),
  });
}

function collapsedIds(): ReadonlyArray<string> {
  return [...useChatDockOpenStore.getState().queueCollapsedByChatId.keys()];
}

describe("chat dock open store: the Message queue fold (#2441)", () => {
  beforeEach(reset);
  afterEach(reset);

  it("starts with every queue open (no entry)", () => {
    expect(collapsedIds()).toEqual([]);
  });

  it("records a fold for the chat that made it and no other", () => {
    useChatDockOpenStore.getState().setQueueCollapsed("chat-a", true);

    expect(collapsedIds()).toEqual(["chat-a"]);
    expect(
      useChatDockOpenStore.getState().queueCollapsedByChatId.get("chat-b"),
    ).toBeUndefined();
  });

  it("deletes the entry when the queue is reopened rather than storing false", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    setQueueCollapsed("chat-a", true);
    setQueueCollapsed("chat-a", false);

    expect(collapsedIds()).toEqual([]);
  });

  it("leaves the state object untouched when opening a chat that has no entry", () => {
    const before = useChatDockOpenStore.getState().queueCollapsedByChatId;
    useChatDockOpenStore.getState().setQueueCollapsed("chat-a", false);

    expect(useChatDockOpenStore.getState().queueCollapsedByChatId).toBe(before);
  });

  it("is independent of the open-section map", () => {
    useChatDockOpenStore.getState().toggleSection("chat-a", "todo");
    useChatDockOpenStore.getState().setQueueCollapsed("chat-a", true);

    expect(useChatDockOpenStore.getState().openByChatId.get("chat-a")).toBe(
      "todo",
    );
    expect(collapsedIds()).toEqual(["chat-a"]);
  });

  it("is bounded at 64 chats and evicts the oldest fold first", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    for (let index = 0; index < 64; index += 1) {
      setQueueCollapsed(`chat-${String(index)}`, true);
    }
    expect(collapsedIds()).toHaveLength(64);

    setQueueCollapsed("chat-64", true);

    const ids = collapsedIds();
    expect(ids).toHaveLength(64);
    expect(ids).not.toContain("chat-0");
    expect(ids).toContain("chat-1");
    expect(ids[ids.length - 1]).toBe("chat-64");
  });

  it("re-folding a chat moves it to the end so the visible chat is not the one evicted", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    for (let index = 0; index < 64; index += 1) {
      setQueueCollapsed(`chat-${String(index)}`, true);
    }
    setQueueCollapsed("chat-0", true);
    setQueueCollapsed("chat-64", true);

    const ids = collapsedIds();
    expect(ids).toContain("chat-0");
    expect(ids).not.toContain("chat-1");
  });
});
