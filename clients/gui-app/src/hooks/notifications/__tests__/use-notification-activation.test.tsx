import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
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
/**
 * `createRequesterForHostId` is not optional decoration: production resolves
 * the app-wide host through the spine's id-pinned requester (redesign P4.2),
 * so a stub without it takes the subject down at first render rather than
 * failing an assertion. One host per fixture means the requester IS the
 * client, which is what makes the self-return honest here.
 */
interface StubActivationHostClient {
  readonly getActiveHostId: () => string | null;
  readonly createRequesterForHostId: (
    hostId: string | null,
  ) => StubActivationHostClient;
}

const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: StubActivationHostClient;
    readonly directory: IHostDirectoryService;
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

/**
 * Moves the app-wide pointer the way the authority does.
 *
 * SEEDED, not stubbed: the origin-host guard reads this store live, and a
 * fixture that mocked the reader instead would leave the guard comparing the
 * mock against itself - it could never catch a real pointer move again. This
 * is the one thing the guard asks about, so it is the one thing the fixture
 * supplies.
 */
function setEffectiveHost(hostId: string | null): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  });
}

function bindStubClient(): void {
  const hostClient: StubActivationHostClient = {
    getActiveHostId: () => activeHostIdStub.value,
    createRequesterForHostId: () => hostClient,
  };
  bindingState.current = {
    hostClient,
    directory: createTestDirectory([]),
  };
}

function createTestDirectory(
  entries: readonly HostDirectoryEntry[],
): IHostDirectoryService {
  return {
    list: () => Promise.resolve(entries),
    findById: (hostId) =>
      entries.find((entry) => entry.hostId === hostId) ?? null,
    refresh: () => Promise.resolve(entries),
    refreshForEra: () => Promise.resolve(entries),
    invalidateInFlightRefresh: () => undefined,
  };
}

describe("useNotificationActivation", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    navigateSpy.mockReset();
    navigateSpy.mockImplementation(() => undefined);
    explicitNavigateCalls.mockReset();
    activeHostIdStub.value = "stub-host";
    // The guard compares the client's captured id against the LIVE pointer;
    // a fixture that seeds only one of them reports a host move on every
    // activation. These cases are not about moving, so they agree.
    setEffectiveHost("stub-host");
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

  it("routes TUI agent notifications to the exact open terminal-agent tile", () => {
    const store = useEpicCanvasStore.getState();
    const notifiedTabId = store.openEpicTab("epic-tui", "TUI task");
    store.openTileInTab(notifiedTabId, {
      id: "tui-notified",
      instanceId: "tui-notified-instance",
      type: "terminal-agent",
      name: "Notified terminal agent",
      hostId: "host-1",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[notifiedTabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected notified TUI agent canvas");
    }
    const paneId = canvas.activePaneId;
    store.openEpicTab("epic-tui", "Other task view");
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "chat",
          epicId: "epic-tui",
          chatId: "tui-notified",
        },
        receivedAt: 904,
        feedId: "host:tui",
        onResult: null,
      });
    });

    expect(navigateSpy.mock.calls[0][0]).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-tui", tabId: notifiedTabId },
      search: {
        focusedAt: 904,
        focusArtifactId: "tui-notified",
        focusPaneId: paneId,
        focusTileInstanceId: "tui-notified-instance",
      },
    });
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
      // Resolves whichever host the pointer names; there is no bound host to
      // fall back on since P4.2 deleted the slot.
      findHostById: (hostId) => (hostId === hostA.hostId ? hostA : hostB),
    });
    setEffectiveHost(hostA.hostId);
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "token",
      }),
    );
    bindingState.current = {
      hostClient: client,
      directory: createTestDirectory([hostA, hostB]),
    };
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("reports failure when the active host rebinds during routing for a host feed", () => {
    const onResult = vi.fn();
    // Capture-before-route / check-after-route: move the APP-WIDE POINTER as
    // a side effect of navigate, so the post-route check sees host B. Before
    // P4.2 this drove `client.bind(hostB)` - the same event expressed against
    // the slot that used to carry it.
    navigateSpy.mockImplementation(() => {
      setEffectiveHost(hostB.hostId);
    });
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostA.hostId,
    );

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-shared" },
        receivedAt: 100,
        feedId: "host:n-1",
        onResult,
      });
    });

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostB.hostId,
    );
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

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostA.hostId,
    );
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
    expect(
      messenger.calls.some(
        (call) => call.method === "host.notifications.markRead",
      ),
    ).toBe(false);
  });

  it("reports success when the pointer moved between render and the click, with no further move during routing", () => {
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    // Move the pointer AFTER render but BEFORE the click, with no
    // intervening re-render - `hook.result.current.activate` still closes
    // over the render-time host. The "before" read must go to the live
    // store rather than that stale closure, or this reports "failure" for a
    // move that happened before routing ever started (no move occurs during
    // routing itself, so a correct guard sees no move at all).
    setEffectiveHost(hostB.hostId);

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-shared" },
        receivedAt: 100,
        feedId: "host:n-1",
        onResult,
      });
    });

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
  });

  // "selects an approval's origin host before routing to its exact tile" is
  // deleted: its subject, `ensureOriginHostSelected`, no longer exists.
  // Activation does not move the app-wide selection at all now (redesign
  // P1.2, D7) - a notification click routes against whatever host the target
  // surface already resolves through.
  //
  // The fail-closed half of that guard came BACK, one limb narrower, and the
  // pin below is it. Deleting the function took the refusal along with the
  // selection write, and only the write was the D7 violation: an origin-
  // required prompt that routed through the wrong host still reported
  // SUCCESS, so the popover closed and marked it read. What is refused now is
  // the acknowledgment, never the navigation, and only on positive evidence
  // that the route went elsewhere - routability itself remains the caller's
  // decision, not this hook's.

  it("declines to ACKNOWLEDGE a cloud approval that routed through a host other than its origin", () => {
    // Host A is effective, the approval was raised on host B, and no B-bound
    // tile is open - so routing falls through to the hostless epic intent and
    // resolves through A. The prompt is only answerable on B, and the feed is
    // a CLOUD one, so `hostFeedStayedOnOrigin` (host feeds only) cannot catch
    // it: without this, activation reported success and the row was marked
    // read for a prompt that was never opened on its host.
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "approval",
          epicId: "epic-origin",
          chatId: "chat-elsewhere",
          approvalId: "approval-host-b",
          sessionId: undefined,
          artifactId: undefined,
        },
        receivedAt: 105,
        feedId: "cloud:approval-host-b",
        originHostId: hostB.hostId,
        onResult,
      });
    });

    // Navigation still happened - opening the epic is useful either way.
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("failure");
    // ...and the app-wide pointer did NOT move to satisfy the origin (D7).
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostA.hostId,
    );
  });

  it("does not reuse a host B tile for a host A approval", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-origin", "Retained B tile");
    store.openTileInTab(tabId, {
      id: "chat-shared",
      instanceId: "host-b-shared-chat",
      type: "chat",
      name: "Host B chat",
      hostId: hostB.hostId,
    });
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "approval",
          epicId: "epic-origin",
          chatId: "chat-shared",
          approvalId: "approval-host-a",
          sessionId: undefined,
          artifactId: undefined,
        },
        receivedAt: 104,
        feedId: "cloud:approval-host-a",
        originHostId: hostA.hostId,
        onResult,
      });
    });

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      hostA.hostId,
    );
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const search = navigateSpy.mock.calls.at(0)?.at(0)?.search;
    if (search === undefined) {
      throw new Error("expected notification navigation search params");
    }
    expect(search).not.toMatchObject({
      focusTileInstanceId: "host-b-shared-chat",
    });
    expect(onResult).toHaveBeenCalledWith("success");
  });
});
