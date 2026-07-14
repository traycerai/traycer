import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayNotificationRows,
  notificationReplaceKey,
} from "@/lib/notifications/notification-display";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

interface CapturedToast {
  readonly title: string;
  readonly options: {
    readonly description: string;
    readonly id: string;
    readonly className?: string;
    readonly onClick?: () => void;
  };
}

const toastCalls = vi.hoisted((): CapturedToast[] => []);

vi.mock("sonner", () => ({
  toast: (title: string, options: CapturedToast["options"]): void => {
    toastCalls.push({ title, options });
  },
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
  beforeEach(() => {
    toastCalls.length = 0;
  });

  it("shows exactly one toast and one chime for one display emission", () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const playChime = vi.fn();

    displayNotificationRows([row("Checkout notifications")], {
      showNotification,
      playChime,
      onToastClick: vi.fn(),
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
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.title).toBe("Checkout notifications");
    expect(toastCalls[0]?.options.description).toBe("New chat • Done");
    expect(toastCalls[0]?.options.id).toBe("host:chat:chat-1");
    expect(toastCalls[0]?.options.className).toBe("cursor-pointer");
    expect(toastCalls[0]?.options.onClick).toBeTypeOf("function");
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
    const onToastClick = vi.fn();
    const first = row("One");

    displayNotificationRows([first, row("Two")], {
      showNotification,
      playChime,
      onToastClick,
    });

    expect(showNotification).toHaveBeenCalledWith(
      "Traycer",
      "2 new notifications",
      expect.anything(),
      "notification-batch",
    );

    toastCalls[0]?.options.onClick?.();

    expect(onToastClick).toHaveBeenCalledWith(first);
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
        onToastClick: vi.fn(),
      });
    }).not.toThrow();

    expect(playChime).toHaveBeenCalledOnce();
  });

  it("activates the notification represented by the toast when clicked", () => {
    const onToastClick = vi.fn();
    const notification = row("Checkout notifications");

    displayNotificationRows([notification], {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick,
    });

    toastCalls[0]?.options.onClick?.();

    expect(onToastClick).toHaveBeenCalledWith(notification);
  });

  it("does not make notifications without a destination clickable", () => {
    displayNotificationRows([{ ...row("Agent finished"), payload: null }], {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    });

    expect(toastCalls[0]?.options.className).toBeUndefined();
    expect(toastCalls[0]?.options.onClick).toBeUndefined();
  });
});
