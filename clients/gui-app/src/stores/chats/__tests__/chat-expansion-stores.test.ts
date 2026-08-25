import { describe, expect, it } from "vitest";
import {
  createChatCollapsibleKey,
  serializeChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import { createA2AOpenStore } from "@/stores/chats/a2a-open-store-context";
import { createChatFindForceStore } from "@/stores/chats/chat-find-force-store-context";

describe("chat expansion stores", () => {
  it("tracks sent and received A2A open ids independently", () => {
    const store = createA2AOpenStore(null);

    store.getState().setSentOpen("sent-1", true);
    store.getState().setReceivedOpen("received-1", true);

    expect(store.getState().sentOpenIds.has("sent-1")).toBe(true);
    expect(store.getState().receivedOpenIds.has("received-1")).toBe(true);
    expect(store.getState().sentOpenIds.has("received-1")).toBe(false);
    expect(store.getState().receivedOpenIds.has("sent-1")).toBe(false);

    store.getState().setSentOpen("sent-1", false);

    expect(store.getState().sentOpenIds.has("sent-1")).toBe(false);
    expect(store.getState().receivedOpenIds.has("received-1")).toBe(true);
  });

  it("keys find-force by serialized tile-scoped collapsible keys", () => {
    const store = createChatFindForceStore();
    const tileAKey = createChatCollapsibleKey("tile-a", "subagent", "seg-1");
    const tileBKey = createChatCollapsibleKey("tile-b", "subagent", "seg-1");

    store.getState().setForcedOpen(tileAKey, true);

    expect(
      store.getState().forcedKeyIds.has(serializeChatCollapsibleKey(tileAKey)),
    ).toBe(true);
    expect(
      store.getState().forcedKeyIds.has(serializeChatCollapsibleKey(tileBKey)),
    ).toBe(false);

    store.getState().setForcedOpen(tileAKey, false);

    expect(store.getState().forcedKeyIds.size).toBe(0);
  });

  it("tracks one tile-scoped active find target and clears only its own key", () => {
    const store = createChatFindForceStore();
    const interviewKey = createChatCollapsibleKey(
      "tile-a",
      "interview",
      "interview-1",
    );
    const otherKey = createChatCollapsibleKey(
      "tile-a",
      "interview",
      "interview-2",
    );

    store.getState().setActiveTarget({ key: interviewKey, unitId: "unit-q2" });

    expect(store.getState().activeTarget).toEqual({
      key: interviewKey,
      unitId: "unit-q2",
    });
    store.getState().clearActiveTarget(otherKey);
    expect(store.getState().activeTarget?.unitId).toBe("unit-q2");

    store.getState().setActiveTarget({ key: interviewKey, unitId: "unit-q3" });
    expect(store.getState().activeTarget?.unitId).toBe("unit-q3");
    store.getState().clearActiveTarget(interviewKey);
    expect(store.getState().activeTarget).toBeNull();

    store.getState().reconcileActiveTarget({
      key: interviewKey,
      unitId: "unit-q3",
    });
    expect(store.getState().activeTarget).toBeNull();
    store.getState().setActiveTarget({ key: interviewKey, unitId: "unit-q3" });
    expect(store.getState().activeTarget?.unitId).toBe("unit-q3");
  });
});
