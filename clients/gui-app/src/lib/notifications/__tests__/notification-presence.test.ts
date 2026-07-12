import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import {
  readHostNotificationPresenceFrame,
  subscribeHostNotificationPresence,
} from "@/lib/notifications/notification-presence";

describe("notification presence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useEpicCanvasStore.setState({
      tabsById: {},
      canvasByTabId: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("projects focused active epic and chat into the v1.1 presence frame", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: "chat-1",
        instanceId: "chat-instance-1",
        type: "chat",
        name: "Chat",
        hostId: "host-1",
      }),
    );

    expect(
      readHostNotificationPresenceFrame({
        windowId: "window-1",
        now: () => 123,
      }),
    ).toEqual({
      kind: "presence",
      hasBinaryPayload: false,
      windowId: "window-1",
      focused: true,
      entity: { epicId: "epic-1", chatId: "chat-1" },
      at: 123,
    });
  });

  it("projects terminal and terminal-agent tiles into their own presence entity", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    useEpicCanvasStore.getState().openTileInTab(tabId, {
      id: "terminal-1",
      instanceId: "terminal-instance-1",
      type: "terminal",
      name: "Terminal",
      titleSource: "default",
      hostId: "host-1",
      cwd: "/repo",
    });
    expect(
      readHostNotificationPresenceFrame({ windowId: "window-1", now: () => 1 })
        .entity,
    ).toEqual({ epicId: "epic-1", chatId: "terminal-1" });

    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: "agent-1",
        instanceId: "agent-instance-1",
        type: "terminal-agent",
        name: "Agent terminal",
        hostId: "host-1",
      }),
    );
    expect(
      readHostNotificationPresenceFrame({ windowId: "window-1", now: () => 2 })
        .entity,
    ).toEqual({ epicId: "epic-1", chatId: "agent-1" });
  });

  it("emits presence updates on focus and active route changes", () => {
    const sendPresence = vi.fn();
    const unsubscribe = subscribeHostNotificationPresence(sendPresence);

    window.dispatchEvent(new Event("focus"));
    useEpicCanvasStore.getState().openEpicTab("epic-2", "Epic 2");

    expect(sendPresence).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
