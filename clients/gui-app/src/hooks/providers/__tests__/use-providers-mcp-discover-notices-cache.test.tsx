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
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpDiscover } from "@/hooks/providers/use-providers-mcp-discover-mutation";
import { toastFromHostError } from "@/lib/host-error-toast";
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
      coverage: null,
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

  it("keeps the previous coverage and takes the checked row's origin (A40)", async () => {
    const origin = {
      scope: "project" as const,
      label: "Project settings",
      path: null,
      inherited: false,
      editable: true,
    };
    const discovered = row("docs", { origin });
    const coverage = {
      complete: false,
      sources: [
        {
          label: "Managed settings",
          path: null,
          scope: "managed" as const,
          outcome: "unsupported" as const,
          reason: "Not readable here.",
        },
      ],
    };
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
      providerId: "kilocode",
      scope: "project",
      workspaceRoot: "/work/repo",
    } as const;
    const listKey = providersNativeQueryKeys.mcpList(
      mockLocalHostEntry.hostId,
      listParams,
    );
    queryClient.setQueryData<McpListData>(listKey, {
      servers: [row("docs", {}), row("other", {})],
      notices: [],
      coverage,
      refreshError: null,
    });
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
    expect(after?.coverage).toEqual(coverage);
    expect(after?.servers[0]?.origin).toEqual(origin);
    expect(after?.servers[1]?.name).toBe("other");
  });

  describe("U4: a Check refusal reaches the toast with the host's sentence", () => {
    const DETAIL = "This server is not in Kilo's settings anymore.";

    async function checkRefused(
      code: "server_not_found" | "unsupported_action",
      detail: string | null,
    ): Promise<string> {
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
              native: { ok: false, code, detail },
            }),
          },
        }),
      });
      spine.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-1",
        }),
      );
      mockClientHolder.client = spine.createRequester(mockLocalHostEntry);
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
      vi.mocked(toastFromHostError).mockClear();
      await act(async () => {
        await rendered.result.current
          .mutateAsync({
            providerId: "kilocode",
            scope: "global",
            workspaceRoot: null,
            serverName: "gone",
            forceRefresh: true,
          })
          .catch(() => undefined);
      });
      const calls = vi.mocked(toastFromHostError).mock.calls;
      expect(calls).toHaveLength(1);
      const first: unknown = calls[0]?.[0];
      return first instanceof Error ? first.message : "";
    }

    it("shows the host detail for server_not_found", async () => {
      expect(await checkRefused("server_not_found", DETAIL)).toBe(DETAIL);
    });

    it("shows the same detail from an old peer's unsupported_action", async () => {
      expect(await checkRefused("unsupported_action", DETAIL)).toBe(DETAIL);
    });

    it("falls back to the provider-neutral copy with no detail", async () => {
      expect(await checkRefused("server_not_found", null)).toBe(
        "This server is no longer in this provider's configuration. Refresh the list.",
      );
    });
  });

  describe("U4: an active list observer re-reads only the matching scope", () => {
    async function observeRefusal(
      code: "server_not_found" | "unsupported_action",
    ): Promise<{
      globalReads: number;
      projectReads: number;
      globalRows: string[];
    }> {
      const reads = { global: 0, project: 0, discover: 0 };
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
            "providers.list": (params) => {
              const native = params.native;
              if (native?.kind === "mcpDiscover") {
                reads.discover += 1;
                return {
                  providers: [],
                  native: { ok: false, code, detail: "Gone." },
                };
              }
              if (native?.kind === "mcp") {
                // The host no longer has the row once it is re-read.
                if (native.scope === "global") reads.global += 1;
                else reads.project += 1;
                return {
                  providers: [],
                  native: {
                    ok: true,
                    kind: "mcp",
                    servers: reads.global > 1 ? [] : [row("gone", {})],
                  },
                };
              }
              return { providers: [], native: null };
            },
          },
        }),
      });
      spine.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-1",
        }),
      );
      mockClientHolder.client = spine.createRequester(mockLocalHostEntry);
      function Wrapper(props: { readonly children: ReactNode }): ReactNode {
        return (
          <QueryClientProvider client={queryClient}>
            {props.children}
          </QueryClientProvider>
        );
      }
      const observed = renderHook(
        () => ({
          global: useProvidersMcpList({
            providerId: "kilocode",
            scope: "global",
            workspaceRoot: null,
            enabled: true,
            pollWhilePending: false,
          }),
          project: useProvidersMcpList({
            providerId: "kilocode",
            scope: "project",
            workspaceRoot: "/work/repo",
            enabled: true,
            pollWhilePending: false,
          }),
          discover: useProvidersMcpDiscover(),
        }),
        { wrapper: Wrapper },
      );
      await waitFor(() => {
        expect(observed.result.current.global.data?.servers).toHaveLength(1);
        expect(observed.result.current.project.data).toBeDefined();
      });
      expect(reads.global).toBe(1);
      expect(reads.project).toBe(1);

      vi.mocked(toastFromHostError).mockClear();
      await act(async () => {
        await observed.result.current.discover
          .mutateAsync({
            providerId: "kilocode",
            scope: "global",
            workspaceRoot: null,
            serverName: "gone",
            forceRefresh: true,
          })
          .catch(() => undefined);
      });
      // Only a refusal that proves the row is gone re-reads; wait on that
      // outcome rather than on time. An old peer's refusal invalidates nothing,
      // so there is nothing to wait for and the counts below are immediate.
      if (code === "server_not_found") {
        await waitFor(() =>
          expect(observed.result.current.global.data?.servers).toHaveLength(0),
        );
      }
      expect(reads.discover).toBe(1);
      return {
        globalReads: reads.global,
        projectReads: reads.project,
        globalRows: (observed.result.current.global.data?.servers ?? []).map(
          (server) => server.name,
        ),
      };
    }

    it("server_not_found makes one complete read of the matching scope, and the stale row goes", async () => {
      const result = await observeRefusal("server_not_found");
      expect(result.globalReads).toBe(2);
      expect(result.projectReads).toBe(1);
      expect(result.globalRows).toEqual([]);
    });

    it("an old peer's unsupported_action triggers no read and keeps the seeded row", async () => {
      const result = await observeRefusal("unsupported_action");
      expect(result.globalReads).toBe(1);
      expect(result.projectReads).toBe(1);
      expect(result.globalRows).toEqual(["gone"]);
    });
  });
});
