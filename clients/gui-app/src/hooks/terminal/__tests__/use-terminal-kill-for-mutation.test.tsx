import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { useTerminalKillFor } from "@/hooks/terminal/use-terminal-kill-for-mutation";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostBelowMinimumError } from "@/lib/host/host-below-minimum-error";

const toastFromHostError = vi.hoisted(() =>
  vi.fn<(error: HostRpcError, fallbackMessage: string) => void>(),
);

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError }));

const HOST_ID = "host-kill-test";
const KILL_REQUEST = {
  sessionId: "terminal-1",
} satisfies RequestOfMethod<HostRpcRegistry, "terminal.kill">;

function renderKillFor(
  trackUserIntent: boolean,
  belowMinimum: HostBelowMinimumError,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "terminal-kill-floor",
    handlers: {},
  });
  const request = vi
    .spyOn(messenger, "request")
    .mockRejectedValue(belowMinimum);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => ({ ...mockLocalHostEntry, hostId }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  const client = spine.createRequesterForHostId(HOST_ID);
  const wrapper = (props: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);

  return {
    ...renderHook(
      () =>
        useTerminalKillFor(client, "Couldn't close terminal.", trackUserIntent),
      { wrapper },
    ),
    queryClient,
    request,
  };
}

describe("useTerminalKillFor floor errors", () => {
  beforeEach(() => {
    toastFromHostError.mockReset();
  });

  it("keeps automatic binding-restart cleanup silent below the host floor", async () => {
    const belowMinimum = new HostBelowMinimumError({
      requestId: "automatic-kill-floor",
      method: "terminal.kill",
    });
    const rendered = renderKillFor(false, belowMinimum);

    await expect(
      rendered.result.current.mutateAsync(KILL_REQUEST),
    ).rejects.toBe(belowMinimum);

    expect(rendered.request).toHaveBeenCalledOnce();
    expect(rendered.request.mock.calls[0]?.[0]).toBe("terminal.kill");
    expect(toastFromHostError).not.toHaveBeenCalled();
    rendered.queryClient.clear();
  });

  it("reports a user initiated terminal close blocked below the host floor", async () => {
    const belowMinimum = new HostBelowMinimumError({
      requestId: "manual-kill-floor",
      method: "terminal.kill",
    });
    const rendered = renderKillFor(true, belowMinimum);

    await expect(
      rendered.result.current.mutateAsync(KILL_REQUEST),
    ).rejects.toBe(belowMinimum);

    expect(rendered.request).toHaveBeenCalledOnce();
    expect(rendered.request.mock.calls[0]?.[0]).toBe("terminal.kill");
    expect(toastFromHostError).toHaveBeenCalledExactlyOnceWith(
      belowMinimum,
      "Couldn't close terminal.",
    );
    rendered.queryClient.clear();
  });
});
