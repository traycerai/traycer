import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  queueFoldKey,
  useChatDockOpenStore,
} from "@/stores/chats/chat-dock-open-store";

const HOST = "host-a";
const OTHER_HOST = "host-b";

function reset(): void {
  useChatDockOpenStore.setState({
    openByChatId: new Map(),
    queueCollapsedByHostChat: new Map(),
  });
}

function collapsedIds(): ReadonlyArray<string> {
  return [...useChatDockOpenStore.getState().queueCollapsedByHostChat.keys()];
}

describe("chat dock open store: the Message queue fold (#2441)", () => {
  beforeEach(reset);
  afterEach(reset);

  it("starts with every queue open (no entry)", () => {
    expect(collapsedIds()).toEqual([]);
  });

  it("records a fold for the chat that made it and no other", () => {
    useChatDockOpenStore.getState().setQueueCollapsed(HOST, "chat-a", true);

    expect(collapsedIds()).toEqual([queueFoldKey(HOST, "chat-a")]);
    expect(
      useChatDockOpenStore
        .getState()
        .queueCollapsedByHostChat.get(queueFoldKey(HOST, "chat-b")),
    ).toBeUndefined();
  });

  it("deletes the entry when the queue is reopened rather than storing false", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    setQueueCollapsed(HOST, "chat-a", true);
    setQueueCollapsed(HOST, "chat-a", false);

    expect(collapsedIds()).toEqual([]);
  });

  it("leaves the state object untouched when opening a chat that has no entry", () => {
    const before = useChatDockOpenStore.getState().queueCollapsedByHostChat;
    useChatDockOpenStore.getState().setQueueCollapsed(HOST, "chat-a", false);

    expect(useChatDockOpenStore.getState().queueCollapsedByHostChat).toBe(
      before,
    );
  });

  it("keeps the same chat id on two hosts independent", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    setQueueCollapsed(HOST, "chat-a", true);
    setQueueCollapsed(OTHER_HOST, "chat-a", true);
    expect(collapsedIds()).toHaveLength(2);

    setQueueCollapsed(HOST, "chat-a", false);

    expect(collapsedIds()).toEqual([queueFoldKey(OTHER_HOST, "chat-a")]);
    const map = useChatDockOpenStore.getState().queueCollapsedByHostChat;
    expect(map.get(queueFoldKey(HOST, "chat-a"))).toBeUndefined();
    expect(map.get(queueFoldKey(OTHER_HOST, "chat-a"))).toBe(true);
  });

  it("does not let a delimiter in an id make two pairs collide", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    setQueueCollapsed("a:b", "c", true);

    expect(collapsedIds()).not.toContain(queueFoldKey("a", "b:c"));
    expect(collapsedIds()).toContain(queueFoldKey("a:b", "c"));
  });

  it("is independent of the open-section map", () => {
    useChatDockOpenStore.getState().toggleSection("chat-a", "todo");
    useChatDockOpenStore.getState().setQueueCollapsed(HOST, "chat-a", true);

    expect(useChatDockOpenStore.getState().openByChatId.get("chat-a")).toBe(
      "todo",
    );
    expect(collapsedIds()).toEqual([queueFoldKey(HOST, "chat-a")]);
  });

  it("is bounded at 64 chats and evicts the oldest fold first", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    for (let index = 0; index < 64; index += 1) {
      setQueueCollapsed(HOST, `chat-${String(index)}`, true);
    }
    expect(collapsedIds()).toHaveLength(64);

    setQueueCollapsed(HOST, "chat-64", true);

    const ids = collapsedIds();
    expect(ids).toHaveLength(64);
    expect(ids).not.toContain(queueFoldKey(HOST, "chat-0"));
    expect(ids).toContain(queueFoldKey(HOST, "chat-1"));
    expect(ids[ids.length - 1]).toBe(queueFoldKey(HOST, "chat-64"));
  });

  it("re-folding a chat moves it to the end so the visible chat is not the one evicted", () => {
    const { setQueueCollapsed } = useChatDockOpenStore.getState();
    for (let index = 0; index < 64; index += 1) {
      setQueueCollapsed(HOST, `chat-${String(index)}`, true);
    }
    setQueueCollapsed(HOST, "chat-0", true);
    setQueueCollapsed(HOST, "chat-64", true);

    const ids = collapsedIds();
    expect(ids).toContain(queueFoldKey(HOST, "chat-0"));
    expect(ids).not.toContain(queueFoldKey(HOST, "chat-1"));
  });
});
