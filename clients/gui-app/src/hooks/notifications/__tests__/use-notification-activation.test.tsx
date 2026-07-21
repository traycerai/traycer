import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
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
const requestMock = vi.hoisted(() => vi.fn());
const activeHostIdStub: { value: string | null } = vi.hoisted(() => ({
  value: "stub-host",
}));
const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: {
      readonly request: (...args: never[]) => unknown;
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
      request: requestMock,
      getActiveHostId: () => activeHostIdStub.value,
    },
  };
}

describe("useNotificationActivation", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    requestMock.mockReset();
    requestMock.mockResolvedValue({
      collaborators: [],
      collaboratorsAvailable: true,
    });
    activeHostIdStub.value = "stub-host";
    bindStubClient();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("reports no-preflight success synchronously when no host runtime is mounted", () => {
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

    expect(requestMock).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("success");
    expect(hook.result.current.pendingFeedId).toBeNull();
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

  it("routes shared epic notifications once, then reports success after preflight", async () => {
    const preflightResponse = {
      collaborators: [],
      collaboratorsAvailable: true,
    };
    let resolvePreflight: (value: typeof preflightResponse) => void = () =>
      undefined;
    requestMock.mockImplementation(
      () =>
        new Promise<typeof preflightResponse>((resolve) => {
          resolvePreflight = resolve;
        }),
    );
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

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const navigateArg = navigateSpy.mock.calls[0][0];
    expect(navigateArg.to).toBe("/epics/$epicId/$tabId");
    expect(navigateArg.params.epicId).toBe("epic-shared");
    expect(navigateArg.search.focusedAt).toBe(123);
    expect(onResult).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("epic.listCollaborators", {
        epicId: "epic-shared",
      });
      expect(hook.result.current.pendingFeedId).toBe("host:n-1");
    });

    await act(async () => {
      resolvePreflight(preflightResponse);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith("success");
    });
    expect(hook.result.current.pendingFeedId).toBeNull();
  });

  it("reports failure when preflight rejects and leaves pending cleared", async () => {
    requestMock.mockRejectedValue(new Error("preflight failed"));
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "chat", epicId: "epic-fail", chatId: "chat-1" },
        receivedAt: 10,
        feedId: "host:fail-1",
        onResult,
      });
    });

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith("failure");
    });
    expect(hook.result.current.pendingFeedId).toBeNull();
  });

  it("ignores a second activate while preflight is pending (route-once + no second onResult)", async () => {
    let resolvePreflight: (value: {
      collaborators: [];
      collaboratorsAvailable: true;
    }) => void = () => undefined;
    requestMock.mockImplementation(
      () =>
        new Promise<{
          collaborators: [];
          collaboratorsAvailable: true;
        }>((resolve) => {
          resolvePreflight = resolve;
        }),
    );
    const onResultFirst = vi.fn();
    const onResultSecond = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-a" },
        receivedAt: 1,
        feedId: "host:a",
        onResult: onResultFirst,
      });
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-b" },
        receivedAt: 2,
        feedId: "host:b",
        onResult: onResultSecond,
      });
    });

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy.mock.calls[0][0].params.epicId).toBe("epic-a");
    expect(onResultSecond).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(hook.result.current.pendingFeedId).toBe("host:a");
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolvePreflight({
        collaborators: [],
        collaboratorsAvailable: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onResultFirst).toHaveBeenCalledTimes(1);
      expect(onResultFirst).toHaveBeenCalledWith("success");
    });
    expect(onResultSecond).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates completion so a resolved preflight only fires onResult once", async () => {
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: {
          kind: "approval",
          epicId: "epic-approval",
          chatId: "chat-approval",
          approvalId: "approval-1",
          sessionId: undefined,
          artifactId: undefined,
        },
        receivedAt: 789,
        feedId: "host:approval-1",
        onResult,
      });
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith("success");
    });

    // A second click after the first completed is a new activation, not a
    // double-complete of the first. The in-flight guard only applies while
    // pending; once complete, a fresh activate is allowed.
    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-next" },
        receivedAt: 790,
        feedId: "host:next",
        onResult,
      });
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(2);
    });
    expect(navigateSpy).toHaveBeenCalledTimes(2);
  });

  it("completes each sequential activation exactly once (no double onResult)", async () => {
    // The in-flight guard forbids two concurrent preflights, so a "stale
    // mutation callback race" in practice is: activation A settles (one
    // onResult), activation B starts, and A must not fire again. Sequential
    // preflights cover that observable contract.
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
    });
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenLastCalledWith("success");
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-2" },
        receivedAt: 2,
        feedId: "host:2",
        onResult,
      });
    });
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(2);
      expect(onResult).toHaveBeenLastCalledWith("success");
    });
    expect(navigateSpy).toHaveBeenCalledTimes(2);
  });

  it("routes terminal notifications to the exact canvas tile", async () => {
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

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("epic.listCollaborators", {
        epicId: "epic-terminal",
      });
    });
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
  });
});

describe("useNotificationActivation origin-host guard (P0-1)", () => {
  const hostA = mockLocalHostEntry;
  const hostB = {
    ...mockRemoteHostEntry,
    hostId: "host-b-switch",
    label: "Switched Host B",
  };

  let resolvePreflight: (value: {
    collaborators: [];
    collaboratorsAvailable: true;
  }) => void = () => undefined;
  let messenger: MockHostMessenger<HostRpcRegistry>;
  let client: HostClient<HostRpcRegistry>;

  beforeEach(() => {
    navigateSpy.mockReset();
    resolvePreflight = () => undefined;
    let requestSeq = 0;
    const queryClient = createTestQueryClient();
    messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `origin-guard-${++requestSeq}`,
      handlers: {
        "epic.listCollaborators": () =>
          new Promise((resolve) => {
            resolvePreflight = resolve;
          }),
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

  it("reports failure when the active host rebinds mid-preflight for a host feed", async () => {
    const onResult = vi.fn();
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

    await waitFor(() => {
      expect(hook.result.current.pendingFeedId).toBe("host:n-1");
      expect(
        messenger.calls.some(
          (call) => call.method === "epic.listCollaborators",
        ),
      ).toBe(true);
    });

    // In-place rebind of the SAME HostClient instance mid-preflight - the
    // reviewer's repro shape. Origin was host A at activate(); completion
    // must refuse to report success against host B.
    act(() => {
      client.bind(hostB);
    });
    expect(client.getActiveHostId()).toBe(hostB.hostId);

    await act(async () => {
      resolvePreflight({
        collaborators: [],
        collaboratorsAvailable: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith("failure");
    });
    // The hook itself never issues markRead; callers only mark on success.
    // Confirm nothing on this client path leaked a host markRead either.
    expect(
      messenger.calls.some(
        (call) => call.method === "host.notifications.markRead",
      ),
    ).toBe(false);
    expect(hook.result.current.pendingFeedId).toBeNull();
  });

  it("reports success when the active host stays put through preflight (control)", async () => {
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

    await waitFor(() => {
      expect(hook.result.current.pendingFeedId).toBe("host:n-1");
    });

    expect(client.getActiveHostId()).toBe(hostA.hostId);

    await act(async () => {
      resolvePreflight({
        collaborators: [],
        collaboratorsAvailable: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith("success");
    });
    expect(
      messenger.calls.some(
        (call) => call.method === "host.notifications.markRead",
      ),
    ).toBe(false);
  });
});
