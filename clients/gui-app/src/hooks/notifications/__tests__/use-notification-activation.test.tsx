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

type CapturedNavigate = {
  readonly to: string;
  readonly params: { readonly epicId: string; readonly tabId: string };
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

import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

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
    navigateSpy.mockReset();
    navigateSpy.mockImplementation(() => undefined);
    activeHostIdStub.value = "stub-host";
    bindStubClient();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
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

    expect(navigateSpy.mock.calls[0][0]).toEqual({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-terminal", tabId },
      search: {
        focusedAt: 901,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: paneId,
        focusTileInstanceId: "terminal-instance",
      },
    });
    expect(onResult).toHaveBeenCalledTimes(1);
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
