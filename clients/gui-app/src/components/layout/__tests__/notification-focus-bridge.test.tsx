import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateSpy,
}));

import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderBridge(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <NotificationFocusBridge />
    </QueryClientProvider>,
  );
}

describe("NotificationFocusBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_777_768_800_000);
    navigateSpy.mockReset();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  it("opens the popover and routes epic payloads", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderBridge();

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick({ kind: "epic", epicId: "epic-1" });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-1", tabId },
      search: {
        focusedAt: 1_777_768_800_000,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    });
  });

  it("opens the popover and routes artifact payloads with an epic id", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-2", "Epic 2");
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick({
        kind: "artifact",
        epicId: "epic-2",
        artifactId: "artifact-7",
        threadId: "thread-3",
      });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-2", tabId },
      search: {
        focusedAt: 1_777_768_800_000,
        focusArtifactId: "artifact-7",
        focusThreadId: "thread-3",
        migrationSource: undefined,
      },
    });
  });

  it("opens the popover and routes chat payloads to the epic", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-9", "Epic 9");
    renderBridge();

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick({ kind: "chat", epicId: "epic-9", chatId: "chat-1" });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-9", tabId },
      search: {
        focusedAt: 1_777_768_800_000,
        focusArtifactId: "chat-1",
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    });
  });

  it("routes in-app Chat toast clicks without opening the popover", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-in-app", "In-app epic");
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordInAppClick(
        {
          kind: "chat",
          epicId: "epic-in-app",
          chatId: "chat-in-app",
        },
        1_777_768_800_123,
      );
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-in-app", tabId },
      search: {
        focusedAt: 1_777_768_800_123,
        focusArtifactId: "chat-in-app",
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    });
  });

  it("parses and routes terminal payloads to their exact canvas tile", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-terminal", "Terminal epic");
    store.openTileInTab(tabId, {
      id: "terminal-1",
      instanceId: "terminal-instance-1",
      type: "terminal",
      name: "Terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/repo",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected terminal canvas");
    }
    const paneId = canvas.activePaneId;
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick({
        kind: "terminal",
        epicId: "epic-terminal",
        terminalId: "terminal-1",
        tabId,
        paneId,
        tileInstanceId: "terminal-instance-1",
      });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-terminal", tabId },
      search: {
        focusedAt: 1_777_768_800_000,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: paneId,
        focusTileInstanceId: "terminal-instance-1",
      },
    });
  });

  it.each([
    ["session", { kind: "session", sessionId: "session-1" }],
    [
      "approval",
      {
        kind: "approval",
        sessionId: "session-2",
        approvalId: "approval-1",
        artifactId: "artifact-9",
      },
    ],
    ["artifact without epicId", { kind: "artifact", artifactId: "artifact-8" }],
  ])(
    "opens the popover without navigating for %s payloads",
    (_label, payload) => {
      renderBridge();

      act(() => {
        useNotificationEventsStore.getState().recordClick(payload);
      });

      expect(useNotificationsPopoverStore.getState().open).toBe(true);
      expect(navigateSpy).not.toHaveBeenCalled();
    },
  );
});
