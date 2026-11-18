import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEpicSidebarExpansionStore } from "../epic-sidebar-expansion-store";

function resetStore(): void {
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
}

describe("useEpicSidebarExpansionStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("does not share same-epic tree expansion state across tabs", () => {
    useEpicSidebarExpansionStore.getState().expand("tab-a", "chats", "node-1");
    useEpicSidebarExpansionStore
      .getState()
      .collapse("tab-a", "chats", "node-2");

    const state = useEpicSidebarExpansionStore.getState();
    expect(state.userExpandedByScope["tab-a::chats"].has("node-1")).toBe(true);
    expect(state.userCollapsedByScope["tab-a::chats"].has("node-2")).toBe(true);
    expect(state.userExpandedByScope["tab-b::chats"]).toBeUndefined();
    expect(state.userCollapsedByScope["tab-b::chats"]).toBeUndefined();
  });

  it("keeps the chats and artifacts panels independent within a tab", () => {
    const store = useEpicSidebarExpansionStore.getState();
    store.expand("tab-a", "chats", "chat-1");
    store.expand("tab-a", "artifacts", "artifact-1");

    // Collapsing all in the chats panel must not touch the artifacts panel.
    store.collapseAll("tab-a", "chats", new Set(["chat-1"]));

    const state = useEpicSidebarExpansionStore.getState();
    expect(state.userExpandedByScope["tab-a::chats"].has("chat-1")).toBe(false);
    expect(state.userCollapsedByScope["tab-a::chats"].has("chat-1")).toBe(true);
    expect(
      state.userExpandedByScope["tab-a::artifacts"].has("artifact-1"),
    ).toBe(true);
    // The artifacts panel was never collapsed, so it has no collapsed scope.
    expect(state.userCollapsedByScope["tab-a::artifacts"]).toBeUndefined();
  });

  it("copies tree expansion overrides for every panel to a derived tab", () => {
    const store = useEpicSidebarExpansionStore.getState();
    store.expand("tab-a", "chats", "node-1");
    store.collapse("tab-a", "chats", "node-2");
    store.expand("tab-a", "artifacts", "artifact-1");

    store.copyTabState("tab-a", "tab-b");
    store.expand("tab-a", "chats", "node-3");

    const state = useEpicSidebarExpansionStore.getState();
    expect(state.userExpandedByScope["tab-b::chats"].has("node-1")).toBe(true);
    expect(state.userExpandedByScope["tab-b::chats"].has("node-3")).toBe(false);
    expect(state.userCollapsedByScope["tab-b::chats"].has("node-2")).toBe(true);
    expect(
      state.userExpandedByScope["tab-b::artifacts"].has("artifact-1"),
    ).toBe(true);
  });
});
