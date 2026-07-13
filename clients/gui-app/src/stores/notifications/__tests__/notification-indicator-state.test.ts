import { describe, expect, it } from "vitest";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

describe("notification indicator state", () => {
  it("merges an unread app-local failure into host indicator flags", () => {
    const state = selectNotificationIndicatorState(
      {
        byId: {
          terminal: {
            id: "terminal",
            updatedAt: 1,
            readAt: null,
            kind: "terminal.closed",
            sourceRef: "terminal",
            payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
            message: "Terminal closed",
            detail: null,
          },
        },
      },
      { epicId: "epic-1", chatId: "chat-1" },
      {
        epics: {},
        chats: {
          "chat-1": {
            unreadFailure: false,
            pendingPrompt: true,
            unreadDone: true,
          },
        },
      },
    );

    expect(state).toEqual({
      unreadFailure: true,
      pendingPrompt: true,
      unreadDone: true,
    });
  });

  it("keeps the epic indicator lit for unread chat-local failures", () => {
    const state = selectNotificationIndicatorState(
      {
        byId: {
          terminal: {
            id: "terminal",
            updatedAt: 1,
            readAt: null,
            kind: "terminal.closed",
            sourceRef: "terminal",
            payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
            message: "Terminal closed",
            detail: null,
          },
        },
      },
      { epicId: "epic-1" },
      { epics: {}, chats: {} },
    );

    expect(state.unreadFailure).toBe(true);
  });
});
