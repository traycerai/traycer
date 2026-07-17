import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

type CapturedNavigate = {
  readonly to: string;
  readonly params: { readonly epicId: string; readonly tabId: string };
  readonly search: {
    readonly focusedAt: number;
    readonly focusArtifactId: string | undefined;
    readonly focusThreadId: string | undefined;
    readonly migrationSource: string | undefined;
    readonly focusPaneId: string | undefined;
    readonly focusTileInstanceId: string | undefined;
  };
};

const navigateSpy = vi.hoisted(() =>
  vi.fn<(options: CapturedNavigate) => void>(),
);
const requestMock = vi.hoisted(() => vi.fn());
const bindingState = vi.hoisted<{
  current: { readonly hostClient: { readonly request: Mock } } | null;
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

describe("useNotificationActivation", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    requestMock.mockReset();
    requestMock.mockResolvedValue({
      collaborators: [],
      collaboratorsAvailable: true,
    });
    bindingState.current = { hostClient: { request: requestMock } };
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("routes shared epic notifications immediately while preflight remains pending", async () => {
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
    const onActivated = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), {
      wrapper: createWrapper(),
    });

    act(() => {
      hook.result.current.activate({
        payload: { kind: "epic", epicId: "epic-shared" },
        receivedAt: 123,
        onActivated,
      });
    });

    const navigateArg = navigateSpy.mock.calls[0][0];
    expect(navigateArg.to).toBe("/epics/$epicId/$tabId");
    expect(navigateArg.params.epicId).toBe("epic-shared");
    expect(navigateArg.params.tabId).toEqual(expect.any(String));
    expect(navigateArg.search).toEqual({
      focusedAt: 123,
      focusArtifactId: undefined,
      focusThreadId: undefined,
      migrationSource: undefined,
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
    expect(onActivated).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("epic.listCollaborators", {
        epicId: "epic-shared",
      });
    });

    await act(async () => {
      resolvePreflight(preflightResponse);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onActivated).toHaveBeenCalledTimes(1);
    });
  });

  it("routes without preflight when no host runtime is mounted", () => {
    bindingState.current = null;
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
        onActivated: null,
      });
    });

    expect(requestMock).not.toHaveBeenCalled();
    const navigateArg = navigateSpy.mock.calls[0][0];
    expect(navigateArg.to).toBe("/epics/$epicId/$tabId");
    expect(navigateArg.params.epicId).toBe("epic-browser");
    expect(navigateArg.params.tabId).toEqual(expect.any(String));
    expect(navigateArg.search).toEqual({
      focusedAt: 456,
      focusArtifactId: "artifact-1",
      focusThreadId: "thread-1",
      migrationSource: undefined,
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
  });

  it("routes approval notifications to the owning chat artifact", async () => {
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
        onActivated: null,
      });
    });

    const navigateArg = navigateSpy.mock.calls[0][0];
    expect(navigateArg.to).toBe("/epics/$epicId/$tabId");
    expect(navigateArg.params.epicId).toBe("epic-approval");
    expect(navigateArg.search).toEqual({
      focusedAt: 789,
      focusArtifactId: "chat-approval",
      focusThreadId: undefined,
      migrationSource: undefined,
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("epic.listCollaborators", {
        epicId: "epic-approval",
      });
    });
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
        onActivated: null,
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
        onActivated: null,
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
