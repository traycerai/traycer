import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import {
  displayHostChannelEmission,
  displayNotificationRows,
  notificationReplaceKey,
} from "@/lib/notifications/notification-display";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

interface CapturedToast {
  readonly title: ReactNode;
  readonly options: {
    readonly description: string | undefined;
    readonly id: string;
  };
}

const toastCalls = vi.hoisted((): CapturedToast[] => []);

vi.mock("sonner", () => ({
  toast: (title: ReactNode, options: CapturedToast["options"]): string => {
    toastCalls.push({ title, options });
    return options.id;
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

  afterEach(() => {
    cleanup();
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
    expect(showNotification).toHaveBeenCalledWith({
      title: "Checkout notifications",
      body: "New chat • Done",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
      },
      replaceKey: "host:chat:chat-1",
      deliveryKey: null,
    });
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.options.id).toBe("host:chat:chat-1");
    expect(toastCalls[0]?.options.description).toBeUndefined();
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

    expect(showNotification).toHaveBeenCalledWith({
      title: "Traycer",
      body: "2 new notifications",
      payload: first.payload,
      replaceKey: "notification-batch",
      deliveryKey: null,
    });

    renderActionableToast();
    fireEvent.click(
      screen.getByRole("button", { name: "Traycer 2 new notifications" }),
    );

    expect(onToastClick).toHaveBeenCalledWith(first, expect.any(Number));
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

    renderActionableToast();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Checkout notifications New chat • Done",
      }),
    );

    expect(onToastClick).toHaveBeenCalledWith(notification, expect.any(Number));
  });

  it("does not make notifications without a destination clickable", () => {
    displayNotificationRows([{ ...row("Agent finished"), payload: null }], {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.title).toBe("Agent finished");
    expect(toastCalls[0]?.options.description).toBe("New chat • Done");
  });

  it("uses the standard toast renderer for actionable notifications", () => {
    displayNotificationRows([row("Checkout notifications")], {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(1);
    expect(isValidElement(toastCalls[0]?.title)).toBe(true);
    expect(toastCalls[0]?.options.description).toBeUndefined();
  });
});

function hostEntry(id: string, chatId: string | null): HostNotificationEntry {
  return {
    id,
    updatedAt: 10,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId,
    payload:
      chatId === null
        ? {
            kind: "epic",
            epicId: "epic-1",
            tuiAgentId: "tui-1",
            agentName: "Agent",
            taskTitle: "Task",
            outcome: "completed",
          }
        : {
            kind: "chat",
            epicId: "epic-1",
            chatId,
            agentName: "Agent",
            taskTitle: "Task",
            outcome: "completed",
          },
  };
}

describe("host channel emission focus gate", () => {
  beforeEach(() => {
    toastCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useEpicCanvasStore.setState({
      tabsById: {},
      canvasByTabId: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    cleanup();
  });

  function focusChatTile(chatId: string): void {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: chatId,
        instanceId: `${chatId}-instance`,
        type: "chat",
        name: "Chat",
        hostId: "host-1",
      }),
    );
  }

  function displayTarget() {
    return {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
  }

  it("suppresses rows addressed to the focused chat, including epic rollups", () => {
    focusChatTile("chat-1");
    const target = displayTarget();

    displayHostChannelEmission(
      [hostEntry("n-1", "chat-1"), hostEntry("n-2", null)],
      target,
    );

    expect(target.showNotification).not.toHaveBeenCalled();
    expect(target.playChime).not.toHaveBeenCalled();
    expect(toastCalls).toHaveLength(0);
  });

  it("still displays rows for a sibling chat in the same epic", () => {
    focusChatTile("chat-1");
    const target = displayTarget();

    displayHostChannelEmission(
      [hostEntry("n-1", "chat-1"), hostEntry("n-2", "chat-2")],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(target.playChime).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
  });

  it("displays rows for the active entity when the window is blurred", () => {
    focusChatTile("chat-1");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const target = displayTarget();

    displayHostChannelEmission([hostEntry("n-1", "chat-1")], target);

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(target.playChime).toHaveBeenCalledOnce();
  });
});

function renderActionableToast(): void {
  const title = toastCalls.at(-1)?.title;
  if (!isValidElement(title)) {
    throw new Error("Expected an actionable standard toast.");
  }
  render(title);
}
