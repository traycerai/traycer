import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostRpcError,
  type RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useAgentStartTerminalSession } from "@/hooks/agent/use-prepare-tui-launch-mutation";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";

vi.mock("sonner", () => {
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

import { toast } from "sonner";

const LAUNCH: RequestOfMethod<HostRpcRegistry, "agent.tui.prepareLaunch"> = {
  harnessId: "codex",
  epicId: "epic-1",
  model: "desk-model",
  reasoningEffort: null,
  agentMode: "regular",
  tuiAgentId: "agent-1",
  harnessSessionId: null,
  terminalAgentArgs: null,
  workspaceMode: "inherit",
  forkSourceHarnessSessionId: null,
  profileId: null,
  forkSourceTuiAgentId: null,
};

function launchClient(error: HostRpcError): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "agent.tui.prepareLaunch": () => {
          throw error;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function toastTitles(): unknown[] {
  return vi.mocked(toast.error).mock.calls.map((call) => call[0]);
}

function start(error: HostRpcError): {
  readonly currentError: () => HostRpcError | null;
} {
  const queryClient = createAppQueryClient();
  const client = launchClient(error);
  const view = renderHook(() => useAgentStartTerminalSession(client), {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
  view.result.current.mutate(LAUNCH);
  return { currentError: () => view.result.current.error };
}

describe("useAgentStartTerminalSession removed-by-person", () => {
  afterEach(() => {
    vi.mocked(toast.error).mockClear();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("a removed-by-person refusal toasts Was removed", async () => {
    start(
      new HostRpcError({
        code: "removed-by-person",
        message: "The send was refused.",
        requestId: "req-1",
        method: "agent.tui.prepareLaunch",
        fatalDetails: null,
      }),
    );
    await waitFor(() => {
      expect(toastTitles()).toContain("Was removed");
    });
  });

  it("keeps the removed-by-person code on the hook error and shows Was removed", async () => {
    const result = start(
      new HostRpcError({
        code: "removed-by-person",
        message: 'No profile "work" is registered for provider "claude-code".',
        requestId: "req-1",
        method: "agent.tui.prepareLaunch",
        fatalDetails: null,
      }),
    );

    await waitFor(() => {
      expect(result.currentError()?.code).toBe("removed-by-person");
      expect(toastTitles()).toContain("Was removed");
    });
  });

  it("an RPC_ERROR toasts today's sentence plus the detail", async () => {
    start(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "The session did not start.",
        requestId: "req-1",
        method: "agent.tui.prepareLaunch",
        fatalDetails: null,
      }),
    );
    await waitFor(() => {
      expect(toastTitles()).toContain(
        "Couldn't start terminal agent session. The session did not start.",
      );
    });
    expect(toastTitles()).not.toContain("Was removed");
  });
});
