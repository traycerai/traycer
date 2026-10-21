import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  SimulatorOpenRequest,
  SimulatorOpenResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/simulator-open-response-timeout";

/**
 * `simulator.open` rides the extended response budget. The policy table's
 * row is only a PERMISSION: a hook that quietly regressed to a plain host
 * mutation would still compile and still pass every outcome-shaped test, and
 * every cold boot over 30 s would fail on the client again while the host
 * went on to boot the simulator.
 */

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

import { useSimulatorOpenMutation } from "@/hooks/simulator/use-simulator-mutations";

const OPEN: SimulatorOpenRequest = {
  epicId: "epic-1",
  simulatorId: "udid-1",
  platform: "ios",
  boot: true,
};

const OPENED: SimulatorOpenResponse = {
  session: {
    epicId: "epic-1",
    ownerUserId: "user-1",
    hostId: mockLocalHostEntry.hostId,
    simulatorId: "udid-1",
    platform: "ios",
    openedAt: "2026-10-19T00:00:00.000Z",
  },
  simulator: {
    simulatorId: "udid-1",
    platform: "ios",
    name: "iPhone 16",
    version: "18.0",
    booted: true,
    physical: false,
  },
};

function buildHostClient(open: () => SimulatorOpenResponse): {
  readonly requester: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "simulator-open-req",
    handlers: { "simulator.open": open },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-simulator-open",
    }),
  );
  return { requester: spine.createRequester(mockLocalHostEntry), messenger };
}

function wrapper(): (props: { children: ReactNode }) => JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSimulatorOpenMutation", () => {
  it("dispatches with the declared boot-length response budget, not the transport default", async () => {
    const { requester, messenger } = buildHostClient(() => OPENED);
    const timeoutSpy = vi.spyOn(messenger, "requestWithResponseTimeout");
    const { result } = renderHook(
      () => useSimulatorOpenMutation(requester, mockLocalHostEntry.hostId),
      { wrapper: wrapper() },
    );
    expect(result.current.supported).toBe(true);
    const onSuccess = vi.fn();
    result.current.mutation.mutate(OPEN, { onSuccess });
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onSuccess.mock.calls[0][0]).toEqual(OPENED);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy.mock.calls[0].slice(0, 3)).toEqual([
      "simulator.open",
      OPEN,
      SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS,
    ]);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("still surfaces a real refusal as a toast", async () => {
    const { requester } = buildHostClient(() => {
      throw new Error("simulator boot failed: timed out after 180000ms");
    });
    const { result } = renderHook(
      () => useSimulatorOpenMutation(requester, mockLocalHostEntry.hostId),
      { wrapper: wrapper() },
    );
    result.current.mutation.mutate(OPEN);
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
  });
});
