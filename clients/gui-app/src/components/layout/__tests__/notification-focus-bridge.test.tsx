import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
import type { NotificationActivationInput } from "@/hooks/notifications/use-notification-activation";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

const navigateSpy = vi.fn();
const activate = vi.hoisted(() =>
  vi.fn<(input: NotificationActivationInput) => void>(),
);
const markAsRead = vi.hoisted(() => vi.fn<(feedId: string) => void>());
const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));
const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));
const notificationFeedModeRef = vi.hoisted(() => ({
  value: "local",
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateSpy,
}));

vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  notificationPayloadRequiresOriginHost: (payload: { readonly kind: string }) =>
    payload.kind === "approval" || payload.kind === "interview",
  useNotificationActivation: () => ({
    activate,
    pendingFeedId: null,
  }),
}));

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationsActions: () => ({
      markAsRead,
      markAllAsRead: vi.fn(),
      loadMoreHost: vi.fn(),
      canLoadMoreHost: false,
      isLoadingMoreHost: false,
      hasHostLoadError: false,
      loadMoreAttention: vi.fn(),
      canLoadMoreAttention: false,
      isLoadingMoreAttention: false,
      hasAttentionLoadError: false,
      loadMoreUnreadRecent: vi.fn(),
      canLoadMoreUnreadRecent: false,
      isLoadingMoreUnreadRecent: false,
      hasUnreadRecentLoadError: false,
    }),
  };
});

// The bridge reads `useEffectiveHostId()` now (redesign P1.2) - the
// authority's derived effective host, not the directory's active-host
// hook - so that is the seam this fixture drives.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => activeHostIdRef.value,
}));

// The notification centre reads its host from `useNotificationHost` (the local
// host that owns the streams), not from the app-wide active host. Projected
// from this suite's existing host ref so the scenario it was already
// describing is unchanged.
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationHostId: () => activeHostIdRef.value,
  useNotificationHost: () => ({ hostId: activeHostIdRef.value, client: null }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

vi.mock("@/lib/notifications/notification-feed-mode", () => ({
  useNotificationFeedMode: () => notificationFeedModeRef.value,
}));

import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";

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

function hostDoneEntry(id: string): HostNotificationEntry {
  return {
    id,
    updatedAt: 20,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: "Task",
      outcome: "completed",
    },
  };
}

function seedHostRow(id: string): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries: [], nextCursor: null },
    recent: { entries: [hostDoneEntry(id)], nextCursor: null },
    summary: { unreadCount: 1, attentionCount: 0 },
  });
}

describe("NotificationFocusBridge", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    vi.useFakeTimers();
    vi.setSystemTime(1_777_768_800_000);
    navigateSpy.mockReset();
    activate.mockReset();
    markAsRead.mockReset();
    notificationFeedModeRef.value = "local";
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) => {
        if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
        if (hostId === "other-host") {
          return {
            ...mockLocalHostEntry,
            hostId: "other-host",
            label: "Other Machine",
            transportDialability: "not-dialable",
          };
        }
        return null;
      },
    };
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    __resetTabNavigationControllerForTesting();
    vi.useRealTimers();
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
  });

  it("opens the center for unknown payloads without routing or acknowledging", () => {
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick({ nonsense: true });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("routes a cloud envelope whose exact row was already pruned", () => {
    notificationFeedModeRef.value = "cloud";
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick(
        buildNotificationActivationEnvelope({
          route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
          feed: { source: "cloud", id: "removed-row" },
          originHostId: "host-a",
        }),
      );
    });

    expect(activate).toHaveBeenCalledTimes(1);
    const input = activate.mock.calls.at(0)?.at(0);
    if (input === undefined) {
      throw new Error("expected cloud activation input");
    }
    input.onResult?.("success");
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("routes a legacy known payload without opening the center or acknowledging", () => {
    renderBridge();

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick({ kind: "epic", epicId: "epic-1" });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({
      payload: { kind: "epic", epicId: "epic-1" },
      receivedAt: 1_777_768_800_000,
      feedId: null,
      originHostId: null,
      onResult: null,
    });
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("routes a legacy artifact payload without opening the center or acknowledging", () => {
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick({
        kind: "artifact",
        epicId: "epic-2",
        artifactId: "artifact-7",
        threadId: "thread-3",
      });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({
      payload: {
        kind: "artifact",
        epicId: "epic-2",
        artifactId: "artifact-7",
        threadId: "thread-3",
      },
      receivedAt: 1_777_768_800_000,
      feedId: null,
      originHostId: null,
      onResult: null,
    });
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it.each([
    [
      "approval",
      {
        kind: "approval" as const,
        epicId: "epic-legacy",
        chatId: "chat-legacy",
        approvalId: "approval-legacy",
        sessionId: undefined,
        artifactId: undefined,
      },
    ],
    [
      "interview",
      {
        kind: "interview" as const,
        epicId: "epic-legacy",
        chatId: "chat-legacy",
        interviewBlockId: "interview-legacy",
      },
    ],
  ])("fails closed for a null-origin legacy %s payload", (_label, payload) => {
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick(payload);
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("routes a legacy chat payload without opening the center or acknowledging", () => {
    renderBridge();

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick({ kind: "chat", epicId: "epic-9", chatId: "chat-1" });
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({
      payload: { kind: "chat", epicId: "epic-9", chatId: "chat-1" },
      receivedAt: 1_777_768_800_000,
      feedId: null,
      originHostId: null,
      onResult: null,
    });
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("routes in-app Chat toast clicks without opening the popover", () => {
    useEpicCanvasStore.getState().openEpicTab("epic-in-app", "In-app epic");
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
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({
      payload: {
        kind: "chat",
        epicId: "epic-in-app",
        chatId: "chat-in-app",
      },
      receivedAt: 1_777_768_800_123,
      feedId: null,
      originHostId: null,
      onResult: null,
    });
    expect(navigateSpy).not.toHaveBeenCalled();
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
    const terminalPayload = {
      kind: "terminal" as const,
      epicId: "epic-terminal",
      terminalId: "terminal-1",
      tabId,
      paneId,
      tileInstanceId: "terminal-instance-1",
    };
    renderBridge();

    act(() => {
      useNotificationEventsStore.getState().recordClick(terminalPayload);
    });

    // Routable payloads activate and leave the center closed (legacy path:
    // feedId/onResult stay null - no envelope to acknowledge against).
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({
      payload: terminalPayload,
      receivedAt: 1_777_768_800_000,
      feedId: null,
      originHostId: null,
      onResult: null,
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["session", { kind: "session", sessionId: "session-1" }],
    [
      "approval missing chat",
      {
        kind: "approval",
        sessionId: "session-2",
        approvalId: "approval-1",
        artifactId: "artifact-9",
      },
    ],
    ["artifact without epicId", { kind: "artifact", artifactId: "artifact-8" }],
  ])(
    "opens the center without activating for non-routable legacy %s payloads",
    (_label, payload) => {
      renderBridge();

      act(() => {
        useNotificationEventsStore.getState().recordClick(payload);
      });

      expect(useNotificationsPopoverStore.getState().open).toBe(true);
      expect(activate).not.toHaveBeenCalled();
      expect(markAsRead).not.toHaveBeenCalled();
    },
  );

  it("routes a V1 origin-valid envelope directly without opening the center", () => {
    renderBridge();
    const envelope = buildNotificationActivationEnvelope({
      route: { kind: "chat", epicId: "epic-9", chatId: "chat-1" },
      feed: { source: "host", id: "n-9" },
      originHostId: mockLocalHostEntry.hostId,
    });

    act(() => {
      useNotificationEventsStore.getState().recordClick(envelope);
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    const firstCall = activate.mock.calls[0][0];
    expect(firstCall).toMatchObject({
      payload: envelope.route,
      receivedAt: 1_777_768_800_000,
      feedId: "host:n-9",
    });
    expect(typeof firstCall.onResult).toBe("function");
  });

  it("acknowledges the correlated feed only on V1 success", () => {
    seedHostRow("n-1");
    renderBridge();
    const envelope = buildNotificationActivationEnvelope({
      route: {
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "approval-1",
        sessionId: undefined,
        artifactId: undefined,
      },
      feed: { source: "host", id: "n-1" },
      originHostId: mockLocalHostEntry.hostId,
    });

    act(() => {
      useNotificationEventsStore.getState().recordClick(envelope);
    });

    const onResult = activate.mock.calls[0][0].onResult;
    expect(typeof onResult).toBe("function");
    if (onResult === null) {
      throw new Error("expected onResult callback");
    }

    act(() => {
      onResult("failure");
    });
    expect(markAsRead).not.toHaveBeenCalled();

    act(() => {
      onResult("success");
    });
    expect(markAsRead).toHaveBeenCalledTimes(1);
    expect(markAsRead).toHaveBeenCalledWith("host:n-1");
  });

  it("origin-mismatch opens origin-unavailable center without routing, acknowledging, or switching hosts", () => {
    renderBridge();
    const envelope = buildNotificationActivationEnvelope({
      route: {
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "approval-1",
        sessionId: undefined,
        artifactId: undefined,
      },
      feed: { source: "host", id: "n-cross" },
      originHostId: "other-host",
    });

    act(() => {
      useNotificationEventsStore.getState().recordClick(envelope);
    });

    const popover = useNotificationsPopoverStore.getState();
    expect(popover.open).toBe(true);
    expect(popover.originUnavailable).toBe(true);
    expect(popover.originUnavailableHostLabel).toBe("Other Machine");
    expect(activate).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    // Active host must stay put - no automatic host switching.
    expect(activeHostIdRef.value).toBe(mockLocalHostEntry.hostId);
  });

  it("opens the center for a non-routable V1 route without activating", () => {
    renderBridge();
    const envelope = buildNotificationActivationEnvelope({
      route: { kind: "session", sessionId: "session-1" },
      feed: { source: "host", id: "n-session" },
      originHostId: mockLocalHostEntry.hostId,
    });

    act(() => {
      useNotificationEventsStore.getState().recordClick(envelope);
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(useNotificationsPopoverStore.getState().originUnavailable).toBe(
      false,
    );
    expect(activate).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("routes a host-less V1 envelope (null origin) without opening the center", () => {
    renderBridge();
    const envelope = buildNotificationActivationEnvelope({
      route: { kind: "epic", epicId: "epic-local" },
      feed: { source: "app-local", id: "local-1" },
      originHostId: null,
    });

    act(() => {
      useNotificationEventsStore.getState().recordClick(envelope);
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    const call = activate.mock.calls[0][0];
    expect(call).toMatchObject({
      payload: envelope.route,
      receivedAt: 1_777_768_800_000,
      feedId: "app-local:local-1",
    });
    expect(typeof call.onResult).toBe("function");
  });

  describe("native activation analytics", () => {
    it("emits zero analytics for legacy activation while still calling activate", () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      renderBridge();

      act(() => {
        useNotificationEventsStore
          .getState()
          .recordClick({ kind: "epic", epicId: "epic-1" });
      });

      expect(activate).toHaveBeenCalledTimes(1);
      expect(activate.mock.calls[0][0].onResult).toBeNull();
      expect(trackSpy).not.toHaveBeenCalled();
      trackSpy.mockRestore();
    });

    it("emits zero activation analytics on origin-unavailable open", () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      renderBridge();
      const envelope = buildNotificationActivationEnvelope({
        route: {
          kind: "approval",
          epicId: "epic-1",
          chatId: "chat-1",
          approvalId: "approval-1",
          sessionId: undefined,
          artifactId: undefined,
        },
        feed: { source: "host", id: "n-cross" },
        originHostId: "other-host",
      });

      act(() => {
        useNotificationEventsStore.getState().recordClick(envelope);
      });

      expect(useNotificationsPopoverStore.getState().open).toBe(true);
      expect(activate).not.toHaveBeenCalled();
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
        ),
      ).toHaveLength(0);
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
        ),
      ).toHaveLength(0);
      trackSpy.mockRestore();
    });

    it("tracks native surface activation and activation-sourced mark-read for V1 success", () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      seedHostRow("n-9");
      renderBridge();
      const envelope = buildNotificationActivationEnvelope({
        route: { kind: "chat", epicId: "epic-9", chatId: "chat-1" },
        feed: { source: "host", id: "n-9" },
        originHostId: mockLocalHostEntry.hostId,
      });

      act(() => {
        useNotificationEventsStore.getState().recordClick(envelope);
      });

      const onResult = activate.mock.calls[0][0].onResult;
      if (onResult === null) {
        throw new Error("expected onResult callback");
      }

      act(() => {
        onResult("failure");
      });
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
        ),
      ).toEqual([
        [
          AnalyticsEvent.NotificationActivationCompleted,
          {
            category: "task",
            section: "recent",
            surface: "native",
            outcome: "failure",
          },
        ],
      ]);
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
        ),
      ).toHaveLength(0);

      act(() => {
        onResult("success");
      });
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
        ),
      ).toHaveLength(2);
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
        ),
      ).toEqual([
        [
          AnalyticsEvent.NotificationMarkedRead,
          {
            category: "task",
            acknowledgment_source: "activation",
          },
        ],
      ]);
      trackSpy.mockRestore();
    });
  });
});
