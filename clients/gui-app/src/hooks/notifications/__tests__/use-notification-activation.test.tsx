import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { NotificationNavigate } from "@/lib/notifications";

type CapturedNavigate = {
  readonly to: string;
  readonly params: { readonly epicId: string; readonly tabId: string };
  readonly replace: boolean;
  readonly state: unknown;
  readonly search: {
    readonly focusedAt: number;
    readonly focusArtifactId: string | undefined;
    readonly focusThreadId: string | undefined;
    readonly migrationSource: string | undefined;
  };
};

const navigateSpy = vi.hoisted(() =>
  vi.fn<(options: CapturedNavigate) => void>(),
);
const explicitNavigateCalls = vi.hoisted(() =>
  vi.fn<(options: unknown) => void>(),
);
const explicitNavigate: NotificationNavigate = (options) => {
  explicitNavigateCalls(options);
  return Promise.resolve();
};
const activeHostIdStub: { value: string | null } = vi.hoisted(() => ({
  value: "stub-host",
}));
const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: {
      readonly getActiveHostId: () => string | null;
    };
  } | null;
}>(() => ({ current: null }));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingState.current,
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

import {
  useNotificationActivation,
  useNotificationActivationWithNavigate,
} from "@/hooks/notifications/use-notification-activation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const queryClient = createTestQueryClient();
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function bindStubClient(): void {
  bindingState.current = {
    hostClient: {
      getActiveHostId: () => activeHostIdStub.value,
    },
  };
}

describe("useNotificationActivation", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    navigateSpy.mockReset();
    navigateSpy.mockImplementation(() => undefined);
    explicitNavigateCalls.mockReset();
    activeHostIdStub.value = "stub-host";
    bindStubClient();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("routes with an explicitly owned router outside ambient router context", () => {
    const hook = renderHook(
      () => useNotificationActivationWithNavigate(explicitNavigate),
      { wrapper: createWrapper() },
    );

    act(() => {
      hook.result.current.activate({
        payload: { kind: "chat", epicId: "epic-owned", chatId: "chat-owned" },
        receivedAt: 789,
        feedId: "host:n-owned",
        onResult: null,
      });
    });

    expect(explicitNavigateCalls).toHaveBeenCalledTimes(1);
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(explicitNavigateCalls.mock.calls[0][0]).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-owned" },
      search: {
        focusedAt: 789,
        focusArtifactId: "chat-owned",
      },
    });
  });

  it("reports success synchronously when no host runtime is mounted", () => {
    bindingState.current = null;
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "artifact",
          epicId: "epic-browser",
          artifactId: "artifact-1",
          threadId: "thread-1",
        },
        receivedAt: 456,
        feedId: "global:g-1",
        onResult,
      });
    });

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
    const navigateArg = navigateSpy.mock.calls[0][0];
    expect(navigateArg.to).toBe("/epics/$epicId/$tabId");
    expect(navigateArg.params.epicId).toBe("epic-browser");
    expect(navigateArg.search).toEqual({
      focusedAt: 456,
      focusArtifactId: "artifact-1",
      focusThreadId: "thread-1",
      migrationSource: undefined,
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
  });

  it("routes then reports success synchronously with no host RPC", () => {
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-shared" },
        receivedAt: 123,
        feedId: "host:n-1",
        onResult,
      });
    });

    // Same tick: route + onResult, no waitFor / no RPC gate.
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const navigateArg = navigateSpy.mock.calls[0][0];
    expect(navigateArg.to).toBe("/epics/$epicId/$tabId");
    expect(navigateArg.params.epicId).toBe("epic-shared");
    expect(navigateArg.search.focusedAt).toBe(123);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
  });

  it("fires onResult synchronously after routing (no async gate)", () => {
    const callOrder: string[] = [];
    navigateSpy.mockImplementation(() => {
      callOrder.push("navigate");
    });
    const onResult = vi.fn(() => {
      callOrder.push("onResult");
    });
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "chat", epicId: "epic-sync", chatId: "chat-1" },
        receivedAt: 10,
        feedId: "host:sync-1",
        onResult,
      });
    });

    expect(callOrder).toEqual(["navigate", "onResult"]);
    expect(onResult).toHaveBeenCalledWith("success");
  });

  it("completes each sequential activation independently", () => {
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-1" },
        receivedAt: 1,
        feedId: "host:1",
        onResult,
      });
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-2" },
        receivedAt: 2,
        feedId: "host:2",
        onResult,
      });
    });

    expect(navigateSpy).toHaveBeenCalledTimes(2);
    expect(navigateSpy.mock.calls[0][0].params.epicId).toBe("epic-1");
    expect(navigateSpy.mock.calls[1][0].params.epicId).toBe("epic-2");
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenNthCalledWith(1, "success");
    expect(onResult).toHaveBeenNthCalledWith(2, "success");
  });

  it("routes terminal notifications to the exact canvas tile", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-terminal", "Terminal epic");
    store.openTileInTab(tabId, {
      id: "setup:chat-1:repo:branch",
      instanceId: "terminal-instance",
      type: "terminal",
      name: "Setup terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/repo",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected terminal canvas");
    }
    const paneId = canvas.activePaneId;
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "terminal",
          epicId: "epic-terminal",
          terminalId: "setup:chat-1:repo:branch",
          tabId,
          paneId,
          tileInstanceId: "terminal-instance",
        },
        receivedAt: 901,
        feedId: "host:term-1",
        onResult,
      });
    });

    const [navigation] = navigateSpy.mock.calls[0];
    expect(navigation).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-terminal", tabId },
      replace: false,
      search: {
        focusedAt: 901,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: paneId,
        focusTileInstanceId: "terminal-instance",
      },
    });
    expect(navigation.state).toEqual(expect.any(Function));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
  });

  // F8 (closure): a retained CLOSED tab that owns the terminal must be reopened
  // by the EXACT payload tabId - never resolved by epic, which prefers the
  // active/MRU same-epic sibling and lands on the wrong tab.
  it("reopens the exact retained tab that owns the terminal, not an MRU sibling", () => {
    const store = useEpicCanvasStore.getState();
    const ownerTabId = store.openEpicTab("epic-dup", "Owner");
    store.openTileInTab(ownerTabId, {
      id: "setup:owner:repo:branch",
      instanceId: "owner-terminal-instance",
      type: "terminal",
      name: "Setup terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/repo",
    });
    const ownerCanvas = useEpicCanvasStore.getState().canvasByTabId[ownerTabId];
    if (ownerCanvas === undefined || ownerCanvas.activePaneId === null) {
      throw new Error("expected owner terminal canvas");
    }
    const ownerPaneId = ownerCanvas.activePaneId;

    // A second tab for the SAME epic becomes the active/MRU sibling, then the
    // owner tab is closed (retained in tabsById, dropped from openTabOrder).
    const siblingTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-dup", "Sibling");
    useEpicCanvasStore.getState().closeTab(ownerTabId);
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(
      ownerTabId,
    );
    expect(useEpicCanvasStore.getState().activeTabId).toBe(siblingTabId);
    // Confirm the resolver WOULD pick the sibling (the exact trap F8 fixes).
    expect(useEpicCanvasStore.getState().resolveTabIdForEpic("epic-dup")).toBe(
      siblingTabId,
    );

    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "terminal",
          epicId: "epic-dup",
          terminalId: "setup:owner:repo:branch",
          tabId: ownerTabId,
          paneId: ownerPaneId,
          tileInstanceId: "owner-terminal-instance",
        },
        receivedAt: 903,
        feedId: "host:owner-term",
        onResult,
      });
    });

    const [navigation] = navigateSpy.mock.calls[0];
    // Reopens the EXACT owner tab, not the MRU sibling.
    expect(navigation.params).toEqual({
      epicId: "epic-dup",
      tabId: ownerTabId,
    });
    expect(navigation.search).toMatchObject({
      focusPaneId: ownerPaneId,
      focusTileInstanceId: "owner-terminal-instance",
    });
    // The owner tab is reopened into the visible strip by the activation.
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(ownerTabId);
    expect(onResult).toHaveBeenCalledWith("success");
  });

  it("routes persisted legacy terminal rows to their open canvas tile", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-legacy", "Legacy terminal epic");
    const terminalId = "setup:chat-legacy:repo:branch";
    store.openTileInTab(tabId, {
      id: terminalId,
      instanceId: "legacy-terminal-instance",
      type: "terminal",
      name: "Setup terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/repo",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected legacy terminal canvas");
    }
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "chat",
          epicId: "epic-legacy",
          chatId: terminalId,
        },
        receivedAt: 902,
        feedId: "host:legacy-term",
        onResult,
      });
    });

    expect(navigateSpy.mock.calls[0][0]).toMatchObject({
      params: { epicId: "epic-legacy", tabId },
      search: {
        focusedAt: 902,
        focusArtifactId: undefined,
        focusPaneId: canvas.activePaneId,
        focusTileInstanceId: "legacy-terminal-instance",
      },
    });
    expect(onResult).toHaveBeenCalledWith("success");
  });

  // Cold review #8: retained closed epic tab records must reopen (via
  // coordinator resolve) before nested-focus preparation + activation.
  it("reopens a retained closed terminal tab before nested-focus activation", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-retained", "Retained terminal epic");
    store.openTileInTab(tabId, {
      id: "setup:chat-retained:repo:branch",
      instanceId: "retained-terminal-instance",
      type: "terminal",
      name: "Setup terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/repo",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected retained terminal canvas");
    }
    const paneId = canvas.activePaneId;

    // Close hides from openTabOrder but keeps tabsById + canvas (retained).
    store.closeTab(tabId);
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(tabId);
    expect(useEpicCanvasStore.getState().tabsById[tabId]?.epicId).toBe(
      "epic-retained",
    );
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "retained-terminal-instance"
      ],
    ).toBeDefined();

    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "terminal",
          epicId: "epic-retained",
          terminalId: "setup:chat-retained:repo:branch",
          tabId,
          paneId,
          tileInstanceId: "retained-terminal-instance",
        },
        receivedAt: 903,
        feedId: "host:retained-term",
        onResult,
      });
    });

    // Reopened (or resolved) tab is source-open again and navigation targets
    // the retained terminal's nested focus — not a silent no-op.
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);
    expect(navigateSpy).toHaveBeenCalled();
    const [navigation] = navigateSpy.mock.calls[0];
    expect(navigation).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-retained", tabId },
      search: {
        focusedAt: 903,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: paneId,
        focusTileInstanceId: "retained-terminal-instance",
      },
    });
    // Envelope is required so the reopen is an owned controller navigation.
    expect(navigation.state).toEqual(expect.any(Function));
    expect(onResult).toHaveBeenCalledWith("success");
  });

  it("routes chat notifications to the exact open chat tile", () => {
    const store = useEpicCanvasStore.getState();
    const notifiedChatTabId = store.openEpicTab("epic-chat", "Chat task");
    store.openTileInTab(notifiedChatTabId, {
      id: "chat-notified",
      instanceId: "chat-notified-instance",
      type: "chat",
      name: "Notified chat",
      hostId: "host-1",
    });
    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[notifiedChatTabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected notified chat canvas");
    }
    const paneId = canvas.activePaneId;
    const otherTabId = store.openEpicTab("epic-chat", "Other task view");
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "chat",
          epicId: "epic-chat",
          chatId: "chat-notified",
        },
        receivedAt: 903,
        feedId: "host:chat",
        onResult: null,
      });
    });

    expect(otherTabId).not.toBe(notifiedChatTabId);
    // `toMatchObject`, not `toEqual`: activation routes through
    // `activateTabIntent`, which also carries `replace` and a `state` thunk.
    expect(navigateSpy.mock.calls[0][0]).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-chat", tabId: notifiedChatTabId },
      search: {
        focusedAt: 903,
        focusArtifactId: "chat-notified",
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: paneId,
        focusTileInstanceId: "chat-notified-instance",
      },
    });
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(
      notifiedChatTabId,
    );
  });

  it("reopens a closed Task at its exact open chat tile", () => {
    const store = useEpicCanvasStore.getState();
    const notifiedChatTabId = store.openEpicTab("epic-hidden", "Hidden task");
    store.openTileInTab(notifiedChatTabId, {
      id: "chat-hidden",
      instanceId: "chat-hidden-instance",
      type: "chat",
      name: "Hidden chat",
      hostId: "host-1",
    });
    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[notifiedChatTabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected hidden chat canvas");
    }
    const paneId = canvas.activePaneId;
    store.closeTab(notifiedChatTabId);
    store.openEpicTab("epic-other", "Other task");
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "chat",
          epicId: "epic-hidden",
          chatId: "chat-hidden",
        },
        receivedAt: 904,
        feedId: "host:hidden-chat",
        onResult: null,
      });
    });

    expect(navigateSpy.mock.calls[0][0]).toMatchObject({
      params: { epicId: "epic-hidden", tabId: notifiedChatTabId },
      search: {
        focusedAt: 904,
        focusArtifactId: "chat-hidden",
        focusPaneId: paneId,
        focusTileInstanceId: "chat-hidden-instance",
      },
    });
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(
      notifiedChatTabId,
    );
  });

  it("reopens the owning Task when both it and its chat were closed", () => {
    const store = useEpicCanvasStore.getState();
    const notifiedChatTabId = store.openEpicTab("epic-closed", "Closed task");
    store.openTileInTab(notifiedChatTabId, {
      id: "chat-closed",
      instanceId: "chat-closed-instance",
      type: "chat",
      name: "Closed chat",
      hostId: "host-1",
    });
    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[notifiedChatTabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected closed chat canvas");
    }
    store.closeCanvasTab(
      notifiedChatTabId,
      canvas.activePaneId,
      "chat-closed-instance",
    );
    store.closeTab(notifiedChatTabId);
    store.openEpicTab("epic-closed", "Other task view");
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "chat",
          epicId: "epic-closed",
          chatId: "chat-closed",
        },
        receivedAt: 905,
        feedId: "host:closed-chat",
        onResult: null,
      });
    });

    expect(navigateSpy.mock.calls[0][0]).toMatchObject({
      params: { epicId: "epic-closed", tabId: notifiedChatTabId },
      search: {
        focusedAt: 905,
        focusArtifactId: "chat-closed",
      },
    });
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(
      notifiedChatTabId,
    );
  });
});

describe("useNotificationActivation origin-host guard (P0-1)", () => {
  const hostA = mockLocalHostEntry;
  const hostB = {
    ...mockRemoteHostEntry,
    hostId: "host-b-switch",
    label: "Switched Host B",
  };

  let messenger: MockHostMessenger<HostRpcRegistry>;
  let client: HostClient<HostRpcRegistry>;

  beforeEach(() => {
    navigateSpy.mockReset();
    navigateSpy.mockImplementation(() => undefined);
    const queryClient = createTestQueryClient();
    let requestSeq = 0;
    messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `origin-guard-${++requestSeq}`,
      handlers: {
        "host.notifications.markRead": () => ({}),
      },
    });
    client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger,
    });
    client.bind(hostA);
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "token",
      }),
    );
    bindingState.current = { hostClient: client };
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("reports failure when the active host rebinds during routing for a host feed", () => {
    const onResult = vi.fn();
    // Capture-before-route / check-after-route: rebind as a side effect of
    // navigate so the post-route active-host check sees host B.
    navigateSpy.mockImplementation(() => {
      client.bind(hostB);
    });
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    expect(client.getActiveHostId()).toBe(hostA.hostId);

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-shared" },
        receivedAt: 100,
        feedId: "host:n-1",
        onResult,
      });
    });

    expect(client.getActiveHostId()).toBe(hostB.hostId);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("failure");
    // The hook itself never issues markRead; callers only mark on success.
    expect(
      messenger.calls.some(
        (call) => call.method === "host.notifications.markRead",
      ),
    ).toBe(false);
  });

  it("reports success when the active host stays put during routing (control)", () => {
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-shared" },
        receivedAt: 100,
        feedId: "host:n-1",
        onResult,
      });
    });

    expect(client.getActiveHostId()).toBe(hostA.hostId);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
    expect(
      messenger.calls.some(
        (call) => call.method === "host.notifications.markRead",
      ),
    ).toBe(false);
  });
});
