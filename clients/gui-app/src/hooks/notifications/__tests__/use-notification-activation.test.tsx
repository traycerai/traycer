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
    });
  });
});
