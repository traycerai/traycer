import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderMcpNotice,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import type { McpListData } from "@/hooks/providers/native-response-map";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => mockClientHolder.client };
});

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

const mockClientHolder: { client: HostClient<HostRpcRegistry> | null } = {
  client: null,
};

afterEach(() => {
  cleanup();
  mockClientHolder.client = null;
});

describe("useProvidersMcpMutate notice reconciliation", () => {
  it("invalidates after a concurrent list changed only notices", async () => {
    const server: ProviderMcpServer = {
      name: "docs",
      enabled: true,
      transport: { type: "http", url: "https://example.com/mcp", auth: null },
      status: "connected",
      statusSource: "probe",
      statusDetail: null,
      tools: [],
      discoveryPending: false,
      instructions: null,
      configOnly: false,
      stdioDegraded: false,
    };
    const oldNotice: ProviderMcpNotice = {
      id: "old",
      tone: "warning",
      text: "Earlier warning",
      blocking: true,
      remedy: null,
    };
    const newNotice: ProviderMcpNotice = {
      ...oldNotice,
      id: "new",
      text: "The current warning",
    };
    let releaseMutation: () => void = () => {};
    const pendingMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const queryClient = createAppQueryClient();
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "providers.nativeMutate": async () => {
            await pendingMutation;
            return {
              result: {
                ok: true,
                kind: "mcp",
                servers: [server],
                notices: [oldNotice],
              },
            };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    mockClientHolder.client = spine.createRequester(mockLocalHostEntry);

    const params = {
      providerId: "kimi",
      scope: "global",
      workspaceRoot: null,
    } as const;
    const listKey = providersNativeQueryKeys.mcpList(
      mockLocalHostEntry.hostId,
      params,
    );
    const seeded: McpListData = {
      servers: [server],
      notices: [oldNotice],
      refreshError: null,
    };
    queryClient.setQueryData<McpListData>(listKey, seeded);
    function Wrapper(props: { readonly children: ReactNode }): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      );
    }
    const rendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: Wrapper,
    });
    let write: Promise<unknown> = Promise.resolve();
    act(() => {
      write = rendered.result.current.mutateAsync({
        ...params,
        mutation: { action: "toggleServer", name: "docs", enabled: true },
        suppressToast: true,
      });
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));

    // A full list read completes during the write with unchanged rows. The
    // late mutation response must trigger reconciliation for its old notice.
    queryClient.setQueryData<McpListData>(listKey, {
      ...seeded,
      notices: [newNotice],
    });
    expect(queryClient.getQueryData<McpListData>(listKey)?.servers).toBe(
      seeded.servers,
    );
    await act(async () => {
      releaseMutation();
      await write;
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
