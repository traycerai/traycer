import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useFocusStopAgent } from "@/hooks/home-focus/use-focus-stop-agent-mutation";

type StopAgentRequest = RequestOfMethod<HostRpcRegistry, "agent.stop">;

/**
 * `useFocusStopAgent` resolves a per-call client from the host directory
 * rather than binding one client for the whole hook (Home lists every task on
 * the account, so two rows can name different machines). It is exercised
 * against a REAL `HostClient` wired to a `MockHostMessenger`, the same shape
 * `use-managed-command-stop-all.test.tsx` uses for the identical
 * per-call-transient-client pattern - real `.request()`/`.getActiveHostId()`
 * behavior, zero hand-stubbed methods.
 */
const { findByIdMock } = vi.hoisted(() => ({
  findByIdMock: vi.fn<(hostId: string) => HostDirectoryEntry | null>(
    () => null,
  ),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostClient,
    useHostDirectory: () => ({ findById: findByIdMock }),
  };
});

const hostA: HostDirectoryEntry = { ...mockLocalHostEntry, hostId: "host-a" };
const hostB: HostDirectoryEntry = { ...mockRemoteHostEntry, hostId: "host-b" };

const agentStopRequests: StopAgentRequest[] = [];
let agentStopResponse: Promise<{ stoppedAgentIds: string[] }> = Promise.resolve(
  { stoppedAgentIds: [] },
);

let hostClient: HostClient<HostRpcRegistry>;
let queryClient: QueryClient;
let invalidateQueries: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function buildSpine(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => {
      if (hostId === hostA.hostId) return hostA;
      if (hostId === hostB.hostId) return hostB;
      return null;
    },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "focus-stop-agent-request",
      handlers: {
        "agent.stop": (params) => {
          agentStopRequests.push(params);
          return agentStopResponse;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "focus-stop-agent-token",
    }),
  );
  return spine;
}

let spine: HostClient<HostRpcRegistry>;

beforeEach(() => {
  findByIdMock.mockReset();
  findByIdMock.mockReturnValue(null);
  agentStopRequests.length = 0;
  agentStopResponse = Promise.resolve({ stoppedAgentIds: ["agent-1"] });
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  spine = buildSpine();
  hostClient = spine.createRequester(hostA);
});

afterEach(() => {
  cleanup();
  hostClient.dispose();
});

describe("useFocusStopAgent", () => {
  it("a named hostId consults the directory and dials that entry's client - the invalidation targets the NAMED host", async () => {
    findByIdMock.mockReturnValue(hostB);
    const { result } = renderHook(() => useFocusStopAgent(), { wrapper });

    act(() => {
      result.current.mutate({
        hostId: "host-b",
        epicId: "epic-1",
        agentId: "agent-1",
        cascade: false,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(findByIdMock).toHaveBeenCalledWith("host-b");
    expect(agentStopRequests).toEqual([
      { epicId: "epic-1", agentId: "agent-1", cascade: false },
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-b", "agent.list"),
    });
  });

  it("hostId: null uses the following client without ever consulting the directory", async () => {
    const { result } = renderHook(() => useFocusStopAgent(), { wrapper });

    act(() => {
      result.current.mutate({
        hostId: null,
        epicId: "epic-1",
        agentId: "agent-1",
        cascade: true,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(findByIdMock).not.toHaveBeenCalled();
    expect(agentStopRequests).toEqual([
      { epicId: "epic-1", agentId: "agent-1", cascade: true },
    ]);
    // `followingClient.getActiveHostId()` is "host-a" - the following client's
    // own bound host - since `variables.hostId` was null.
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-a", "agent.list"),
    });
  });

  it("a named hostId the directory cannot resolve rejects rather than silently falling back to the following client", async () => {
    findByIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useFocusStopAgent(), { wrapper });

    act(() => {
      result.current.mutate({
        hostId: "host-missing",
        epicId: "epic-1",
        agentId: "agent-1",
        cascade: false,
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Had it fallen back to the following client (bound to host-a), this
    // would have succeeded and sent a request - it must do neither.
    expect(agentStopRequests).toEqual([]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates the host captured at SEND time, not the one live when the mutation settles", async () => {
    let resolvePromise: (value: { stoppedAgentIds: string[] }) => void = () =>
      undefined;
    agentStopResponse = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const { result, rerender } = renderHook(() => useFocusStopAgent(), {
      wrapper,
    });

    // hostId: null - `onMutate` captures `followingClient.getActiveHostId()`,
    // which is "host-a" at this instant.
    act(() => {
      result.current.mutate({
        hostId: null,
        epicId: "epic-1",
        agentId: "agent-1",
        cascade: false,
      });
    });
    await waitFor(() => expect(agentStopRequests).toHaveLength(1));

    // The window re-points to a DIFFERENT host while the stop is still in
    // flight - the same host-swap race `use-host-notifications-set-config-
    // mutation.test.tsx` drives for the identical invariant.
    act(() => {
      hostClient = spine.createRequester(hostB);
    });
    rerender();

    await act(async () => {
      resolvePromise({ stoppedAgentIds: ["agent-1"] });
      await agentStopResponse;
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope("host-a", "agent.list"),
      });
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-b", "agent.list"),
    });
  });
});
