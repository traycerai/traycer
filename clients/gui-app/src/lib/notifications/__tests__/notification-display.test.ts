import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import {
  clearDisplayedDeliveryKeysForTests,
  displayForwardedForegroundNotification,
  displayHostChannelEmission,
  displayNotificationRows,
  notificationReplaceKey,
} from "@/lib/notifications/notification-display";
import type { NotificationForegroundDisplay } from "@traycer-clients/shared/platform/runner-host";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
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
    originHostId: null,
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
    resolvedAt: null,
    sourceRef: null,
    category: "task",
  };
}

describe("notification display", () => {
  beforeEach(() => {
    toastCalls.length = 0;
    clearDisplayedDeliveryKeysForTests();
    // The in-app toast only renders in a focused window; jsdom reports
    // unfocused by default.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows exactly one toast and one chime for one display emission", () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const playChime = vi.fn();

    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification,
        playChime,
        onToastClick: vi.fn(),
      },
      "origin-host-1",
    );

    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith({
      title: "Checkout notifications",
      body: "New chat • Done",
      payload: buildNotificationActivationEnvelope({
        route: {
          kind: "chat",
          epicId: "epic-1",
          chatId: "chat-1",
        },
        feed: { source: "host", id: "n-1" },
        originHostId: "origin-host-1",
      }),
      replaceKey: "host:chat:chat-1",
      deliveryKey: "host:n-1:10",
      foregroundAppLocal: null,
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

    displayNotificationRows(
      [first, { ...row("Two"), sourceId: "n-2" }],
      {
        showNotification,
        playChime,
        onToastClick,
      },
      "origin-host-1",
    );

    expect(showNotification).toHaveBeenCalledWith({
      title: "Traycer",
      body: "2 new notifications",
      payload: buildNotificationActivationEnvelope({
        route: {
          kind: "chat",
          epicId: "epic-1",
          chatId: "chat-1",
        },
        feed: { source: "host", id: "n-1" },
        originHostId: "origin-host-1",
      }),
      replaceKey: "notification-batch",
      deliveryKey: "host:n-1:10|host:n-2:10",
      foregroundAppLocal: null,
    });

    renderActionableToast();
    fireEvent.click(
      screen.getByRole("button", { name: "Traycer 2 new notifications" }),
    );

    expect(onToastClick).toHaveBeenCalledWith(first);
  });

  it("still plays the chime when native notification setup throws", () => {
    const showNotification = vi.fn(() => {
      throw new Error("native notification unavailable");
    });
    const playChime = vi.fn();

    expect(() => {
      displayNotificationRows(
        [row("Checkout notifications")],
        {
          showNotification,
          playChime,
          onToastClick: vi.fn(),
        },
        null,
      );
    }).not.toThrow();

    expect(playChime).toHaveBeenCalledOnce();
  });

  it("activates the notification represented by the toast when clicked", () => {
    const onToastClick = vi.fn();
    const notification = row("Checkout notifications");

    displayNotificationRows(
      [notification],
      {
        showNotification: vi.fn(() => Promise.resolve()),
        playChime: vi.fn(),
        onToastClick,
      },
      "origin-host-1",
    );

    renderActionableToast();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Checkout notifications New chat • Done",
      }),
    );

    expect(onToastClick).toHaveBeenCalledWith(notification);
  });

  it("does not make notifications without a destination clickable", () => {
    const showNotification = vi.fn(() => Promise.resolve());
    displayNotificationRows(
      [{ ...row("Agent finished"), payload: null }],
      {
        showNotification,
        playChime: vi.fn(),
        onToastClick: vi.fn(),
      },
      "origin-host-1",
    );

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.title).toBe("Agent finished");
    expect(toastCalls[0]?.options.description).toBe("New chat • Done");
    // Payload-less rows still show native, but with a null activation payload.
    expect(showNotification).toHaveBeenCalledWith({
      title: "Agent finished",
      body: "New chat • Done",
      payload: null,
      replaceKey: "host:id:n-1",
      deliveryKey: "host:n-1:10",
      foregroundAppLocal: null,
    });
  });

  it("uses the standard toast renderer for actionable notifications", () => {
    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification: vi.fn(() => Promise.resolve()),
        playChime: vi.fn(),
        onToastClick: vi.fn(),
      },
      null,
    );

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
    clearDisplayedDeliveryKeysForTests();
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
      showNotification: vi.fn(
        (_input: {
          readonly title: string;
          readonly body: string;
          readonly payload: unknown;
          readonly replaceKey: string | null;
          readonly deliveryKey: string | null;
        }) => Promise.resolve(),
      ),
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
      "stream-host-1",
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
      "stream-host-1",
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(target.playChime).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
    const nativeCall = target.showNotification.mock.calls[0][0];
    expect(nativeCall).toMatchObject({
      payload: {
        kind: "notificationActivation",
        version: 1,
        feed: { source: "host", id: "n-2" },
        originHostId: "stream-host-1",
        route: {
          kind: "chat",
          epicId: "epic-1",
          chatId: "chat-2",
        },
      },
      replaceKey: "host:chat:chat-2",
      deliveryKey: "host:n-2:10",
    });
    expect(typeof nativeCall.title).toBe("string");
    expect(typeof nativeCall.body).toBe("string");
  });

  it("hands blurred-window rows to the native pass without a local toast", () => {
    focusChatTile("chat-1");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const target = displayTarget();

    displayHostChannelEmission(
      [hostEntry("n-1", "chat-1")],
      target,
      "stream-host-1",
    );

    // Blur disarms the focus gate, so the row must still go out - but only
    // through the native pass (OS banner or foreground relay). A toast and
    // chime in a window nobody is looking at reach nobody.
    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(target.playChime).not.toHaveBeenCalled();
    expect(toastCalls).toHaveLength(0);
  });
});

describe("forwarded foreground display gate", () => {
  beforeEach(() => {
    toastCalls.length = 0;
    clearDisplayedDeliveryKeysForTests();
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

  function forwardedDisplay(
    chatId: string | null,
    deliveryKey: string | null,
  ): NotificationForegroundDisplay {
    return {
      title: "Agent",
      body: "Agent • Stopped",
      payload: buildNotificationActivationEnvelope({
        route:
          chatId === null
            ? { kind: "epic", epicId: "epic-1" }
            : { kind: "chat", epicId: "epic-1", chatId },
        feed: { source: "cloud", id: "entry-1" },
        originHostId: "origin-host-1",
      }),
      replaceKey: "host:chat:chat-1",
      deliveryKey,
      foregroundAppLocal: null,
    };
  }

  it("drops a relayed display addressed to the focused chat", () => {
    // The cross-window repro: a background window (blurred, so its own gate
    // is disarmed) displays a cloud arrival for the chat THIS window is
    // focused on; the main process relays it here. Without the receive-side
    // gate it toasts over the very chat the user is looking at.
    focusChatTile("chat-1");
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay("chat-1", null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("drops a relayed epic-level display while any tile of that epic is focused", () => {
    focusChatTile("chat-1");
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay(null, null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("renders a relayed display for a sibling chat", () => {
    focusChatTile("chat-1");
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay("chat-2", null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("skips a relayed display this window already rendered locally", () => {
    focusChatTile("chat-2");
    const target = {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
    // Local feed display for chat-1 (not focused) renders and records
    // `host:n-1:10`; the same occurrence relayed back from another window
    // must not chime a second time.
    displayNotificationRows([row("Agent finished")], target, "origin-host-1");
    expect(toastCalls).toHaveLength(1);

    const playChime = vi.fn();
    displayForwardedForegroundNotification(
      forwardedDisplay("chat-1", "host:n-1:10"),
      { playChime, onToastClick: vi.fn() },
    );

    expect(toastCalls).toHaveLength(1);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("skips the local render for an occurrence a relay already displayed", () => {
    focusChatTile("chat-2");
    const playChime = vi.fn();
    displayForwardedForegroundNotification(
      forwardedDisplay("chat-1", "host:n-1:10"),
      { playChime, onToastClick: vi.fn() },
    );
    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();

    const target = {
      showNotification: vi.fn(() => Promise.resolve()),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
    displayNotificationRows([row("Agent finished")], target, "origin-host-1");

    // The native pass still runs (the main process dedups it by the same
    // key); only the duplicate local toast and chime are skipped.
    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).not.toHaveBeenCalled();
  });

  it("renders a payload-less relayed display unchanged", () => {
    focusChatTile("chat-1");
    const playChime = vi.fn();

    displayForwardedForegroundNotification(
      {
        title: "Traycer",
        body: "Something happened",
        payload: null,
        replaceKey: null,
        deliveryKey: null,
        foregroundAppLocal: null,
      },
      { playChime, onToastClick: vi.fn() },
    );

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });
});

function renderActionableToast(): void {
  const title = toastCalls.at(-1)?.title;
  if (!isValidElement(title)) {
    throw new Error("Expected an actionable standard toast.");
  }
  render(title);
}
