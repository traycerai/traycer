import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
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
import { useProvidersMcpDiscover } from "@/hooks/providers/use-providers-mcp-discover-mutation";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return {
    ...actual,
    useHostClient: () => mockClientHolder.client,
    useHostRuntimeClient: () => mockClientHolder.client,
  };
});

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

const mockClientHolder: { client: HostClient<HostRpcRegistry> | null } = {
  client: null,
};

function row(name: string, overrides: Partial<ProviderMcpServer>) {
  const server: ProviderMcpServer = {
    name,
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
    ...overrides,
  };
  return server;
}

const NOTICE: ProviderMcpNotice = {
  id: "project-untrusted",
  tone: "warning",
  text: "This project is not trusted.",
  blocking: false,
  remedy: { id: "trust", label: "Trust", confirmation: "Trust this folder?" },
};

afterEach(() => {
  cleanup();
  mockClientHolder.client = null;
});

describe("useProvidersMcpDiscover list cache", () => {
  it("merges the discovered row without dropping the cached list notices", async () => {
    const discovered = row("docs", { instructions: "Use carefully." });
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
          "providers.list": () => ({
            providers: [],
            native: { ok: true, kind: "mcpDiscover", server: discovered },
          }),
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    mockClientHolder.client = spine.createRequester(mockLocalHostEntry);

    const listParams = {
      providerId: "kimi",
      scope: "global",
      workspaceRoot: null,
    } as const;
    const listKey = providersNativeQueryKeys.mcpList(
      mockLocalHostEntry.hostId,
      listParams,
    );
    const seeded: McpListData = {
      servers: [row("docs", {}), row("other", {})],
      notices: [NOTICE],
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
    const rendered = renderHook(() => useProvidersMcpDiscover(), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await rendered.result.current.mutateAsync({
        ...listParams,
        serverName: "docs",
        forceRefresh: false,
      });
    });

    const after = queryClient.getQueryData<McpListData>(listKey);
    expect(after?.notices).toEqual([NOTICE]);
    expect(after?.servers.map((server) => server.name)).toEqual([
      "docs",
      "other",
    ]);
    expect(after?.servers[0]).toEqual(discovered);
  });
});
