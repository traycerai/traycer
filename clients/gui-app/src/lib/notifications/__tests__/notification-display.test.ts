import { describe, expect, it, vi } from "vitest";
import { displayNotificationRows } from "@/lib/notifications/notification-display";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

function row(text: string): MergedNotificationRow {
  return {
    feedId: "host:n-1",
    source: "host",
    sourceId: "n-1",
    createdAt: 10,
    readAt: null,
    text,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    hostKind: "agent.stopped",
    appLocalKind: null,
    globalEntry: null,
    severity: "done",
    outcome: "completed",
  };
}

describe("notification display", () => {
  it("shows exactly one toast and one chime for one display emission", () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const playChime = vi.fn();

    displayNotificationRows([row("Agent finished")], {
      showNotification,
      playChime,
    });

    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith("Traycer", "Agent finished", {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
    });
    expect(playChime).toHaveBeenCalledOnce();
  });
});
