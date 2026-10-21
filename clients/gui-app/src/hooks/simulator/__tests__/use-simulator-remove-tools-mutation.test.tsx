import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SimulatorRemoveToolsResponse } from "@traycer/protocol/host/simulator/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

/**
 * Settings' Remove: the host's refusal (simulators still on, a helper still
 * running, the store held by another process) is an ordinary host error on
 * the wire, and the hook is what turns it into the toast the row relies on.
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

import { useSimulatorRemoveToolsMutation } from "@/hooks/simulator/use-simulator-mutations";

function buildHostClient(
  remove: () => SimulatorRemoveToolsResponse,
): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "simulator-remove-req",
    handlers: { "simulator.removeTools": remove },
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
      bearerToken: "tok-simulator-remove",
    }),
  );
  return spine.createRequester(mockLocalHostEntry);
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

describe("useSimulatorRemoveToolsMutation", () => {
  it("answers with the removed versions and toasts nothing", async () => {
    const requester = buildHostClient(() => ({
      removed: ["0.15.3-0.21.25.22.23.3"],
    }));
    const { result } = renderHook(
      () =>
        useSimulatorRemoveToolsMutation(requester, mockLocalHostEntry.hostId),
      { wrapper: wrapper() },
    );
    expect(result.current.supported).toBe(true);
    const onSuccess = vi.fn();
    result.current.mutation.mutate({}, { onSuccess });
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onSuccess.mock.calls[0][0]).toEqual({
      removed: ["0.15.3-0.21.25.22.23.3"],
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("toasts the host's refusal", async () => {
    const requester = buildHostClient(() => {
      throw new Error(
        "simulator tools removal refused (reason=enabled): Turn simulators off before removing the tools.",
      );
    });
    const { result } = renderHook(
      () =>
        useSimulatorRemoveToolsMutation(requester, mockLocalHostEntry.hostId),
      { wrapper: wrapper() },
    );
    result.current.mutation.mutate({});
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
  });
});
