import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  displayNotificationRows,
  notificationReplaceKey,
} from "@/lib/notifications/notification-display";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

vi.mock("sonner", () => ({
  toast: vi.fn(),
}));

function row(title: string): MergedNotificationRow {
  return {
    feedId: "host:n-1",
    source: "host",
    sourceId: "n-1",
    createdAt: 10,
    readAt: null,
    title,
    body: "New chat • Done",
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

    displayNotificationRows([row("Checkout notifications")], {
      showNotification,
      playChime,
    });

    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      "Checkout notifications",
      "New chat • Done",
      {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
      },
      "host:chat:chat-1",
    );
    expect(toast).toHaveBeenCalledWith("Checkout notifications", {
      description: "New chat • Done",
      id: "host:chat:chat-1",
    });
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("derives replacement keys from notification entities", () => {
    const chatRow = row("Question waiting");
    const epicRow: MergedNotificationRow = {
      ...chatRow,
      sourceId: "epic-entry",
      payload: { kind: "epic", epicId: "epic-2" },
    };
    const interviewRow: MergedNotificationRow = {
      ...chatRow,
      sourceId: "interview-entry",
      payload: {
        kind: "interview",
        epicId: "epic-3",
        chatId: "chat-3",
        interviewBlockId: "interview-1",
      },
    };
    const idFallbackRow: MergedNotificationRow = {
      ...chatRow,
      sourceId: "unparseable-entry",
      payload: null,
    };
    const appLocalRow: MergedNotificationRow = {
      ...chatRow,
      source: "app-local",
      sourceId: "stream.transport.error:chat-1:lost",
    };

    expect(notificationReplaceKey(chatRow)).toBe("host:chat:chat-1");
    expect(notificationReplaceKey(epicRow)).toBe("host:epic:epic-2");
    expect(notificationReplaceKey(interviewRow)).toBe("host:chat:chat-3");
    expect(notificationReplaceKey(idFallbackRow)).toBe(
      "host:id:unparseable-entry",
    );
    expect(notificationReplaceKey(appLocalRow)).toBe(
      "stream.transport.error:chat-1:lost",
    );
  });

  it("reuses a chat key across prompt and completion entries", () => {
    const prompt: MergedNotificationRow = {
      ...row("Approval needed"),
      sourceId: "approval-1",
      payload: {
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "approval-1",
        sessionId: undefined,
        artifactId: undefined,
      },
    };
    const completion = row("Agent finished");

    expect(notificationReplaceKey(prompt)).toBe(
      notificationReplaceKey(completion),
    );
  });

  it("uses one key for batched notifications", () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const playChime = vi.fn();

    displayNotificationRows([row("One"), row("Two")], {
      showNotification,
      playChime,
    });

    expect(showNotification).toHaveBeenCalledWith(
      "Traycer",
      "2 new notifications",
      expect.anything(),
      "notification-batch",
    );
  });

  it("still plays the chime when native notification setup throws", () => {
    const showNotification = vi.fn(() => {
      throw new Error("native notification unavailable");
    });
    const playChime = vi.fn();

    expect(() => {
      displayNotificationRows([row("Checkout notifications")], {
        showNotification,
        playChime,
      });
    }).not.toThrow();

    expect(playChime).toHaveBeenCalledOnce();
  });
});
