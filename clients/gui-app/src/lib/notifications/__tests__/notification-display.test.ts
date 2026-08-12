import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostNotificationEntry,
  HostNotificationsCloudFeedRow,
} from "@traycer/protocol/host/notifications/contracts";
import {
  displayAppLocalNotification,
  displayCloudSnapshotArrivals,
  displayForwardedForegroundNotification,
  displayHostChannelEmission,
  displayNotificationRows,
  notificationReplaceKey,
} from "@/lib/notifications/notification-display";
import type {
  NotificationForegroundDisplay,
  NotificationShowOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";

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
    // The in-app toast only renders in a focused window; jsdom reports
    // unfocused by default.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows exactly one toast and one chime for one display emission", () => {
    const showNotification = vi.fn(() =>
      Promise.resolve<NotificationShowOutcome>("presented"),
    );
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
      deliveryKey: JSON.stringify([JSON.stringify(["host:n-1", 10, null])]),
      feedSource: "host",
      foregroundAppLocal: null,
    });
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.options.id).toBe("host:chat:chat-1");
    expect(toastCalls[0]?.options.description).toBeUndefined();
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("carries the app-local origin host through native display", async () => {
    const showNotification = vi.fn(() =>
      Promise.resolve<NotificationShowOutcome>("presented"),
    );
    const entry: AppLocalNotificationEntry = {
      id: "stream.transport.error:host-b:chat-1:lost",
      originHostId: "host-b",
      updatedAt: 10,
      readAt: null,
      kind: "stream.transport.error",
      sourceRef: "chat-1",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      message: "Agent stream closed unexpectedly",
      detail: "Connection lost",
      displayedUpdatedAt: null,
    };

    await displayAppLocalNotification(
      entry,
      {
        showNotification,
        playChime: vi.fn(),
        onToastClick: vi.fn(),
      },
      "delivery-1",
      "user-1",
    );

    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: buildNotificationActivationEnvelope({
          route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
          feed: { source: "app-local", id: entry.id },
          originHostId: "host-b",
        }),
      }),
    );
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

  it("separates a same-millisecond prompt supersede by source ref", () => {
    // An approval reopened inside one Date.now() tick keeps its semantic id
    // and updatedAt and only changes sourceRef. A delivery key without the
    // source ref would collide with the prompt it superseded, and the dedup
    // would suppress the new approval's notification entirely.
    const showNotification = vi.fn(
      (_input: { readonly deliveryKey: string | null }) =>
        Promise.resolve<NotificationShowOutcome>("presented"),
    );
    const prompt: MergedNotificationRow = {
      ...row("Approval needed"),
      sourceId: "approval.requested:chat-1",
      feedId: "host:approval.requested:chat-1",
      sourceRef: "approval-1",
    };
    const reopened: MergedNotificationRow = {
      ...prompt,
      sourceRef: "approval-2",
    };

    displayNotificationRows(
      [prompt],
      { showNotification, playChime: vi.fn(), onToastClick: vi.fn() },
      null,
    );
    displayNotificationRows(
      [reopened],
      { showNotification, playChime: vi.fn(), onToastClick: vi.fn() },
      null,
    );

    const keys = showNotification.mock.calls.map((call) => call[0].deliveryKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(toastCalls).toHaveLength(2);
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
    const showNotification = vi.fn(() =>
      Promise.resolve<NotificationShowOutcome>("presented"),
    );
    const playChime = vi.fn();
    const onToastClick = vi.fn();
    const first = row("One");

    displayNotificationRows(
      [first, { ...row("Two"), feedId: "host:n-2", sourceId: "n-2" }],
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
      deliveryKey: JSON.stringify([
        JSON.stringify(["host:n-1", 10, null]),
        JSON.stringify(["host:n-2", 10, null]),
      ]),
      feedSource: "host",
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
        showNotification: vi.fn(() =>
          Promise.resolve<NotificationShowOutcome>("presented"),
        ),
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
    const showNotification = vi.fn(() =>
      Promise.resolve<NotificationShowOutcome>("presented"),
    );
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
      deliveryKey: JSON.stringify([JSON.stringify(["host:n-1", 10, null])]),
      feedSource: "host",
      foregroundAppLocal: null,
    });
  });

  it("uses the standard toast renderer for actionable notifications", () => {
    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification: vi.fn(() =>
          Promise.resolve<NotificationShowOutcome>("presented"),
        ),
        playChime: vi.fn(),
        onToastClick: vi.fn(),
      },
      null,
    );

    expect(toastCalls).toHaveLength(1);
    expect(isValidElement(toastCalls[0]?.title)).toBe(true);
    expect(toastCalls[0]?.options.description).toBeUndefined();
  });

  it("plays one fallback chime when the shell reports undeliverable", async () => {
    // Platforms where Electron cannot present notifications, app blurred: the
    // main process shows nothing, relays nothing, and burns the delivery key.
    // The winning window - the only one to hear `undeliverable` - owns the
    // sole audible cue; its focus-gated chime was skipped because it is
    // blurred, so this is not a duplicate.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const playChime = vi.fn();

    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification: vi.fn(() =>
          Promise.resolve<NotificationShowOutcome>("undeliverable"),
        ),
        playChime,
        onToastClick: vi.fn(),
      },
      "origin-host-1",
    );

    await vi.waitFor(() => {
      expect(playChime).toHaveBeenCalledOnce();
    });
    // The toast still rendered - unseen but harmless, and never load-bearing.
    expect(toastCalls).toHaveLength(1);
  });

  it("stays silent in a blurred window when the shell presented elsewhere", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const playChime = vi.fn();
    const showNotification = vi.fn(() =>
      Promise.resolve<NotificationShowOutcome>("presented"),
    );

    displayNotificationRows(
      [row("Checkout notifications")],
      { showNotification, playChime, onToastClick: vi.fn() },
      "origin-host-1",
    );

    await vi.waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(playChime).not.toHaveBeenCalled();
  });

  it("stays silent in a blurred window when another window won the delivery", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const playChime = vi.fn();
    const showNotification = vi.fn(() =>
      Promise.resolve<NotificationShowOutcome>("duplicate"),
    );

    displayNotificationRows(
      [row("Checkout notifications")],
      { showNotification, playChime, onToastClick: vi.fn() },
      "origin-host-1",
    );

    await vi.waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(playChime).not.toHaveBeenCalled();
  });

  it("chimes once when focus is lost while an undeliverable outcome is pending", async () => {
    // Focused at render (chime played), blurred by the time the shell answers
    // `undeliverable`: the guard is the recorded render-time chime, not a
    // second focus read - a re-read would see "blurred" and double-chime.
    const hasFocus = vi.spyOn(document, "hasFocus");
    hasFocus.mockReturnValueOnce(true);
    hasFocus.mockReturnValue(false);
    const playChime = vi.fn();

    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification: vi.fn(() =>
          Promise.resolve<NotificationShowOutcome>("undeliverable"),
        ),
        playChime,
        onToastClick: vi.fn(),
      },
      "origin-host-1",
    );

    await vi.waitFor(() => {
      expect(playChime).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("chimes once when focus arrives while an undeliverable outcome is pending", async () => {
    // Blurred at render (no chime), focused by the time the shell answers
    // `undeliverable`: nothing has voiced this occurrence yet, so the
    // fallback must still play - a focus re-read would see "focused",
    // assume the render chimed, and leave the arrival silent.
    const hasFocus = vi.spyOn(document, "hasFocus");
    hasFocus.mockReturnValueOnce(false);
    hasFocus.mockReturnValue(true);
    const playChime = vi.fn();

    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification: vi.fn(() =>
          Promise.resolve<NotificationShowOutcome>("undeliverable"),
        ),
        playChime,
        onToastClick: vi.fn(),
      },
      "origin-host-1",
    );

    await vi.waitFor(() => {
      expect(playChime).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("does not double-chime when focus lands before an undeliverable outcome", async () => {
    // Focused at render time -> the focus-gated chime already played. If the
    // main process still answered `undeliverable` (it read focus moments
    // earlier), the fallback must not add a second voice.
    const playChime = vi.fn();

    displayNotificationRows(
      [row("Checkout notifications")],
      {
        showNotification: vi.fn(() =>
          Promise.resolve<NotificationShowOutcome>("undeliverable"),
        ),
        playChime,
        onToastClick: vi.fn(),
      },
      "origin-host-1",
    );

    await vi.waitFor(() => {
      expect(playChime).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(playChime).toHaveBeenCalledOnce();
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

function cloudRow(
  id: string,
  chatId: string,
  originHostId: string,
): HostNotificationsCloudFeedRow {
  return {
    entryId: id,
    originHostId,
    coalesceKey: id,
    entry: hostEntry(id, chatId),
    presentation: { epicTitle: null, chatTitle: null },
  };
}

const EMISSION_N1_N2_DELIVERY_KEY = JSON.stringify([
  JSON.stringify(["host:n-1", 10, "n-1"]),
  JSON.stringify(["host:n-2", 10, "n-2"]),
]);

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
        hostId: "stream-host-1",
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
        }) => Promise.resolve<NotificationShowOutcome>("presented"),
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
      // Names the whole emission, not this window's visible subset.
      deliveryKey: EMISSION_N1_N2_DELIVERY_KEY,
    });
    expect(typeof nativeCall.title).toBe("string");
    expect(typeof nativeCall.body).toBe("string");
  });

  it("still displays the same chat when it arrives from another host", () => {
    focusChatTile("chat-1");
    const target = displayTarget();

    displayHostChannelEmission(
      [hostEntry("host-b-chat", "chat-1")],
      target,
      "stream-host-2",
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(target.playChime).toHaveBeenCalledOnce();
  });

  it("keeps cloud focus suppression scoped to the row's origin host", () => {
    focusChatTile("chat-1");
    const target = displayTarget();

    displayCloudSnapshotArrivals(
      [cloudRow("cloud-host-b-chat", "chat-1", "stream-host-2")],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(target.playChime).toHaveBeenCalledOnce();
  });

  it("keys an emission identically whether or not this window filtered it", () => {
    // Delivery identity must survive focus filtering. A focused window that
    // drops the focused row and a background window that keeps it are showing
    // the SAME emission; if their keys differed, neither the main-process nor
    // the renderer-local set would dedupe, and the focused window would show
    // its filtered toast plus the relayed full batch - two chimes.
    const entries = [hostEntry("n-1", "chat-1"), hostEntry("n-2", "chat-2")];

    focusChatTile("chat-1");
    const focused = displayTarget();
    displayHostChannelEmission(entries, focused, "stream-host-1");

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const background = displayTarget();
    displayHostChannelEmission(entries, background, "stream-host-1");

    const focusedKey = focused.showNotification.mock.calls[0][0].deliveryKey;
    const backgroundKey =
      background.showNotification.mock.calls[0][0].deliveryKey;
    expect(focusedKey).toBe(EMISSION_N1_N2_DELIVERY_KEY);
    expect(backgroundKey).toBe(focusedKey);
    // Each simulated window renders its own subset - the focused one shows
    // only the sibling row, the background one the full batch - but the
    // shared key is what lets the main process deliver the emission once.
    expect(toastCalls.map((call) => call.options.id)).toEqual([
      "host:chat:chat-2",
      "notification-batch",
    ]);
    expect(focused.playChime).toHaveBeenCalledOnce();
    expect(background.playChime).not.toHaveBeenCalled();
  });

  it("renders a blurred window's toast but withholds its chime", () => {
    focusChatTile("chat-1");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const target = displayTarget();

    displayHostChannelEmission(
      [hostEntry("n-1", "chat-1")],
      target,
      "stream-host-1",
    );

    // Blur disarms the entity gate, so the row goes out. The toast must
    // still render: the main process relays nothing back to a focused
    // sender, so a renderer that skipped its own toast could leave the
    // arrival with no surface when focus lands between the two checks.
    // Only the chime - audible from a window nobody is looking at, and
    // never the sole delivery - is withheld.
    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).not.toHaveBeenCalled();
  });
});

describe("forwarded foreground display gate", () => {
  beforeEach(() => {
    toastCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Both feed stores are module-level; without a reset the last test's
    // connection state leaks into every later test and any suite after this
    // file, making `ownFeedIsDelivering` order-dependent.
    useCloudNotificationsStore.setState({
      connectionState: "unavailable",
      hasSnapshot: false,
    });
    __resetHostNotificationsStoreForTests();
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
        hostId: "origin-host-1",
      }),
    );
  }

  function connectedCloudFeed(): void {
    useCloudNotificationsStore.setState({
      connectionState: "connected",
      hasSnapshot: true,
    });
  }

  function disconnectedCloudFeed(): void {
    useCloudNotificationsStore.setState({
      connectionState: "reconnecting",
      hasSnapshot: false,
    });
  }

  function deliveringHostFeed(): void {
    useHostNotificationsStore.getState().setConnectionStatus("open");
    useHostNotificationsStore.setState({
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  }

  function openHostFeedAwaitingSnapshot(): void {
    useHostNotificationsStore.getState().setConnectionStatus("open");
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
      feedSource: "cloud",
      foregroundAppLocal: null,
    };
  }

  it("ignores a relayed feed display while our own feed is delivering", () => {
    // Every window holds its own feed subscription, so the relayed row is
    // already arriving here directly - filtered by THIS window's focus and
    // with per-row content the sender's batch summary cannot reproduce.
    focusChatTile("chat-2");
    connectedCloudFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay("chat-1", null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("ignores a relayed feed display whose payload degraded to null", () => {
    // `payloadFromHostEntry` degrades an unrecognized payload - a newer
    // host's shape, a cross-kind row - to null while the row's durable
    // epicId/chatId stay authoritative. Those relays carry no route to gate
    // on, so treating them as unattributable would hand exactly the rows the
    // gate cannot inspect straight past it. They are feed rows: this window
    // receives its own copy, gated on the durable columns.
    focusChatTile("chat-1");
    connectedCloudFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(
      {
        title: "Agent",
        body: "Agent • Stopped",
        payload: null,
        replaceKey: "host:id:n-9",
        deliveryKey: null,
        feedSource: "host",
        foregroundAppLocal: null,
      },
      { playChime, onToastClick: vi.fn() },
    );

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("renders a relayed feed display when our own feed is not delivering", () => {
    // A feed stream can go terminal without the window noticing. Then the
    // relay is the only copy of the row this window will ever see, so
    // dropping it as redundant would swallow it.
    focusChatTile("chat-2");
    disconnectedCloudFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay("chat-1", null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });

  function forwardedHostFeedDisplay(
    chatId: string,
  ): NotificationForegroundDisplay {
    return {
      ...forwardedDisplay(chatId, null),
      feedSource: "host",
      payload: buildNotificationActivationEnvelope({
        route: { kind: "chat", epicId: "epic-1", chatId },
        feed: { source: "host", id: "n-1" },
        originHostId: "origin-host-1",
      }),
    };
  }

  it("renders a relay while the host stream is open awaiting its snapshot", () => {
    // Transport `open` is not usability: the stream reports open before the
    // first snapshot lands, and that snapshot is a silent baseline - it never
    // calls the channel emission. A relay dropped in that window would be the
    // only copy of the occurrence this renderer had.
    focusChatTile("chat-2");
    openHostFeedAwaitingSnapshot();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedHostFeedDisplay("chat-1"), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("ignores a host relay once the host snapshot has landed", () => {
    focusChatTile("chat-2");
    deliveringHostFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedHostFeedDisplay("chat-1"), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("renders a cloud relay when only the local feed is delivering", () => {
    // Windows can transiently disagree on feed mode. A cloud arrival relayed
    // from a cloud-mode window can name a remote host's occurrence, which the
    // v1 local feed will never emit - and once this window upgrades to cloud,
    // the occurrence lands inside its silent baseline snapshot. The local
    // feed therefore never covers a cloud-source relay.
    focusChatTile("chat-2");
    deliveringHostFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay("chat-1", null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("renders a payload-less cloud relay when only the local feed is delivering", () => {
    // A cloud row with an unrecognized payload ships a null activation
    // envelope, so provenance must ride the display's feedSource field: the
    // local feed cannot reproduce a remote host's occurrence, and without
    // the field this relay would be dropped as redundant - then land inside
    // this window's later silent baseline snapshot, permanently unheard.
    focusChatTile("chat-2");
    deliveringHostFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(
      {
        title: "Agent",
        body: "Agent • Stopped",
        payload: null,
        replaceKey: "host:id:remote-1",
        deliveryKey: null,
        feedSource: "cloud",
        foregroundAppLocal: null,
      },
      { playChime, onToastClick: vi.fn() },
    );

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("still gates a fallback relay on the focused entity", () => {
    // The original repro, on the fallback path: even when the relay is our
    // only copy, it must not toast about the chat we are looking at.
    focusChatTile("chat-1");
    disconnectedCloudFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay("chat-1", null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("gates a fallback epic-level relay while any tile of that epic is focused", () => {
    focusChatTile("chat-1");
    disconnectedCloudFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(forwardedDisplay(null, null), {
      playChime,
      onToastClick: vi.fn(),
    });

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("renders an app-local relay addressed to the focused entity", () => {
    // App-local rows (terminal closed/crashed, transport errors, routed host
    // errors) are never entity-suppressed on their own path, and the emission
    // controller records their display receipt BEFORE relaying - so dropping
    // one here loses it permanently. Only host-feed relays may be gated.
    focusChatTile("chat-1");
    const playChime = vi.fn();

    displayForwardedForegroundNotification(
      {
        title: "Terminal closed",
        body: 'Host "Mac" is unreachable.',
        payload: buildNotificationActivationEnvelope({
          route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
          feed: { source: "app-local", id: "terminal.closed:t-1" },
          originHostId: null,
        }),
        replaceKey: "terminal.closed:t-1",
        deliveryKey: null,
        feedSource: "app-local",
        foregroundAppLocal: { userId: "user-1", entry: { id: "t-1" } },
      },
      { playChime, onToastClick: vi.fn() },
    );

    expect(toastCalls).toHaveLength(1);
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("treats a legacy relay as a feed row rather than rendering it blind", () => {
    // A legacy payload carries no feed identity. It is still not app-local -
    // only `foregroundAppLocal` and an app-local envelope say that - so it is
    // a feed row this window already receives itself.
    focusChatTile("chat-2");
    connectedCloudFeed();
    const playChime = vi.fn();

    displayForwardedForegroundNotification(
      {
        title: "Agent",
        body: "Agent • Stopped",
        payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        replaceKey: "host:chat:chat-1",
        deliveryKey: null,
        feedSource: null,
        foregroundAppLocal: null,
      },
      { playChime, onToastClick: vi.fn() },
    );

    expect(toastCalls).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });
});

function renderActionableToast(): void {
  const title = toastCalls.at(-1)?.title;
  if (!isValidElement(title)) {
    throw new Error("Expected an actionable standard toast.");
  }
  render(title);
}
