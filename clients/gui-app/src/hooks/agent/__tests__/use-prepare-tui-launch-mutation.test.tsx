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
import { useAgentStartTerminalSession } from "@/hooks/agent/use-prepare-tui-launch-mutation";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostBelowMinimumError } from "@/lib/host/host-below-minimum-error";

const toastFromHostErrorWithDetail = vi.hoisted(() =>
  vi.fn<(error: HostRpcError, fallbackMessage: string) => void>(),
);

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostErrorWithDetail }));

const HOST_ID = "host-gesture-test";
const LAUNCH_REQUEST = {
  harnessId: "codex",
  epicId: "epic-test",
  model: null,
  reasoningEffort: null,
  agentMode: "regular",
  tuiAgentId: null,
  harnessSessionId: null,
  terminalAgentArgs: null,
  forkSourceHarnessSessionId: null,
  profileId: null,
  forkSourceTuiAgentId: null,
} satisfies RequestOfMethod<HostRpcRegistry, "agent.tui.prepareLaunch">;

function renderPrepareLaunch(
  origin: "gesture" | "automatic",
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
    requestId: () => "prepare-launch-floor",
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
    ...renderHook(() => useAgentStartTerminalSession(client, origin), {
      wrapper,
    }),
    queryClient,
    request,
  };
}

describe("useAgentStartTerminalSession floor errors", () => {
  beforeEach(() => {
    toastFromHostErrorWithDetail.mockReset();
  });

  it("reports a user initiated launch blocked below the host floor", async () => {
    const belowMinimum = new HostBelowMinimumError({
      requestId: "gesture-floor",
      method: "agent.tui.prepareLaunch",
    });
    const rendered = renderPrepareLaunch("gesture", belowMinimum);

    await expect(
      rendered.result.current.mutateAsync(LAUNCH_REQUEST),
    ).rejects.toBe(belowMinimum);

    expect(rendered.request).toHaveBeenCalledOnce();
    expect(rendered.request.mock.calls[0]?.[0]).toBe("agent.tui.prepareLaunch");
    expect(toastFromHostErrorWithDetail).toHaveBeenCalledExactlyOnceWith(
      belowMinimum,
      "Couldn't start terminal agent session.",
    );
    rendered.queryClient.clear();
  });

  it("keeps automatic restore below the host floor silent", async () => {
    const belowMinimum = new HostBelowMinimumError({
      requestId: "automatic-floor",
      method: "agent.tui.prepareLaunch",
    });
    const rendered = renderPrepareLaunch("automatic", belowMinimum);

    await expect(
      rendered.result.current.mutateAsync(LAUNCH_REQUEST),
    ).rejects.toBe(belowMinimum);

    expect(rendered.request).toHaveBeenCalledOnce();
    expect(rendered.request.mock.calls[0]?.[0]).toBe("agent.tui.prepareLaunch");
    expect(toastFromHostErrorWithDetail).not.toHaveBeenCalled();
    rendered.queryClient.clear();
  });
});
