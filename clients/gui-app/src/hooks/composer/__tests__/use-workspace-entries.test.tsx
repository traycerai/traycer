import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContext } from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useWorkspaceEntries } from "../use-workspace-entries";

let messenger: MockHostMessenger<HostRpcRegistry>;
let hostClient: HostClient<HostRpcRegistry>;

function createHostClient(): HostClient<HostRpcRegistry> {
  messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers: {},
    requestId: () => "request-test",
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => {} },
  });
  client.bind({
    hostId: "host-test",
    label: "Test Host",
    kind: "mock",
    websocketUrl: "ws://host.test",
    version: "test",
    status: "available",
  });
  client.setRequestContext(
    createRequestContext({
      identity: {
        userId: "user-test",
        username: "test",
        providerHandle: null,
      },
      bearerToken: "token-test",
      origin: "test",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
    }),
  );
  return client;
}

function wrapper(props: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useWorkspaceEntries", () => {
  beforeEach(() => {
    hostClient = createHostClient();
  });

  afterEach(() => {
    cleanup();
  });

  it("requests host-backed workspace mention suggestions", async () => {
    messenger.setHandlers({
      "workspace.mentionFiles": () => ({
        entries: [
          {
            kind: "file",
            id: "file:/repo/src/app.ts",
            label: "app.ts",
            relPath: "src/app.ts",
            absolutePath: "/repo/src/app.ts",
            workspacePath: "/repo",
            description: "src",
          },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [
            {
              method: "workspace.mentionFiles",
              params: { roots: ["/repo"], query: "app", limit: 8 },
            },
          ],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(messenger.calls).toEqual([
      expect.objectContaining({
        method: "workspace.mentionFiles",
        params: { roots: ["/repo"], query: "app", limit: 8 },
        requestId: "request-test",
      }),
    ]);
  });

  it("does not request suggestions without request descriptors", () => {
    renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [],
        }),
      { wrapper },
    );

    expect(messenger.calls).toHaveLength(0);
  });
});
