import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderMcpNotice,
  ProviderMcpServer,
  ProviderMcpServerTransportWrite,
} from "@traycer/protocol/host/provider-native-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import type { McpListData } from "@/hooks/providers/native-response-map";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
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

function staleRow(name: string): ProviderMcpServer {
  return {
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
  };
}

const FAKE_MCP_SECRET = "synthetic-mcp-secret";

interface MutationObserverReference {
  readonly options: unknown;
}

function containsFakeMcpSecret(value: unknown): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string") {
      return current.includes(FAKE_MCP_SECRET);
    }
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      return false;
    }
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      current instanceof Error &&
      (current.message.includes(FAKE_MCP_SECRET) || contains(current.cause))
    ) {
      return true;
    }
    return Object.values(current).some(contains);
  }
  return contains(value);
}

function mutationStateContainsFakeMcpSecret(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
): boolean {
  return (
    queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) =>
        containsFakeMcpSecret({
          variables: mutation.state.variables,
          context: mutation.state.context,
          data: mutation.state.data,
          error: mutation.state.error,
          meta: mutation.options.meta,
        }),
      ) || observers.some((observer) => containsFakeMcpSecret(observer.options))
  );
}

const mutationCacheUnsubscribers: Array<() => void> = [];

function captureMutationObservers(
  queryClient: QueryClient,
): MutationObserverReference[] {
  const observers: MutationObserverReference[] = [];
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "observerAdded") observers.push(event.observer);
  });
  mutationCacheUnsubscribers.push(unsubscribe);
  return observers;
}

afterEach(() => {
  cleanup();
  mockClientHolder.client = null;
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
});

describe("useProvidersMcpMutate notice reconciliation", () => {
  it.each([
    { settles: "successfully" as const, fail: false },
    { settles: "with an error" as const, fail: true },
  ])(
    "sends the credential at dispatch and retains no credential after it settles $settles",
    async ({ fail }) => {
      const observations = {
        outgoingRequestContainsSecret: false,
        rejectionContainsSecret: false,
      };
      const queryClient = createAppQueryClient();
      const observers = captureMutationObservers(queryClient);
      const messenger = new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-secret-retention",
        handlers: {
          "providers.nativeMutate": (params) => {
            observations.outgoingRequestContainsSecret =
              containsFakeMcpSecret(params);
            if (fail) throw new Error("Safe MCP failure");
            return {
              result: { ok: true, kind: "mcp", servers: [], notices: [] },
            };
          },
        },
      });
      const client = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        invalidator: createHostQueryInvalidator(queryClient),
        findHostById: (hostId) =>
          hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
        messenger,
      });
      client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-retention",
        }),
      );
      mockClientHolder.client = client.createRequester(mockLocalHostEntry);
      function Wrapper(props: { readonly children: ReactNode }): ReactNode {
        return (
          <QueryClientProvider client={queryClient}>
            {props.children}
          </QueryClientProvider>
        );
      }
      const transport: ProviderMcpServerTransportWrite = {
        type: "http",
        url: "https://example.com/mcp",
        auth: {
          type: "header",
          name: "Authorization",
          value: FAKE_MCP_SECRET,
          additionalHeaders: [],
        },
      };
      const rendered = renderHook(
        () => {
          const submittedTransport =
            useSubmittedSecretInput<ProviderMcpServerTransportWrite>(
              "MCP transport input is unavailable.",
            );
          return {
            mutation: useProvidersMcpMutate(
              submittedTransport.read,
              submittedTransport.clear,
            ),
            submittedTransport,
          };
        },
        { wrapper: Wrapper },
      );
      await act(async () => {
        rendered.result.current.submittedTransport.set(transport);
        try {
          await rendered.result.current.mutation.mutateAsync({
            providerId: "codex",
            scope: "global",
            workspaceRoot: null,
            mutation: { action: "add", name: "docs" },
            suppressToast: true,
          });
        } catch (error) {
          observations.rejectionContainsSecret = containsFakeMcpSecret(error);
        }
      });
      await waitFor(() =>
        expect(rendered.result.current.mutation.status).toBe(
          fail ? "error" : "success",
        ),
      );
      const retainedMutation = queryClient.getMutationCache().getAll().at(-1);
      if (retainedMutation === undefined) {
        throw new Error("MCP mutation was not retained");
      }
      const mutationFn = retainedMutation.options.mutationFn;
      if (mutationFn === undefined) {
        throw new Error("MCP mutation has no mutation function");
      }
      const outgoingCallCount = messenger.calls.filter(
        (call) => call.method === "providers.nativeMutate",
      ).length;
      let replayRefused = false;
      let replayErrorContainsSecret = false;
      try {
        await mutationFn(
          {
            providerId: "codex",
            scope: "global",
            workspaceRoot: null,
            mutation: { action: "add", name: "docs" },
            suppressToast: true,
          },
          {
            client: queryClient,
            meta: retainedMutation.options.meta,
            mutationKey: retainedMutation.options.mutationKey ?? [],
          },
        );
      } catch (error) {
        replayRefused =
          error instanceof Error &&
          error.message === "MCP transport input is unavailable.";
        replayErrorContainsSecret = containsFakeMcpSecret(error);
      }
      expect(
        observations.outgoingRequestContainsSecret &&
          !mutationStateContainsFakeMcpSecret(queryClient, observers) &&
          !containsFakeMcpSecret(rendered.result.current) &&
          !observations.rejectionContainsSecret &&
          replayRefused &&
          !replayErrorContainsSecret &&
          messenger.calls.filter(
            (call) => call.method === "providers.nativeMutate",
          ).length === outgoingCallCount &&
          (fail ? retainedMutation.state.status === "error" : true),
      ).toBe(true);
      client.dispose();
    },
  );

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
    const rendered = renderHook(() => useProvidersMcpMutate(null, null), {
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

  it("invalidates when the mutation result says a source was not refreshed", async () => {
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
          "providers.nativeMutate": () => ({
            result: {
              ok: true,
              kind: "mcp",
              servers: [server],
              notices: [],
              coverage: {
                complete: false,
                sources: [
                  {
                    label: "Global settings",
                    path: null,
                    scope: "global",
                    outcome: "unrefreshed",
                    reason: null,
                  },
                ],
              },
            },
          }),
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    mockClientHolder.client = spine.createRequester(mockLocalHostEntry);
    const params = {
      providerId: "kilocode",
      scope: "global",
      workspaceRoot: null,
    } as const;
    const listKey = providersNativeQueryKeys.mcpList(
      mockLocalHostEntry.hostId,
      params,
    );
    queryClient.setQueryData<McpListData>(listKey, {
      servers: [server],
      notices: [],
      coverage: null,
      refreshError: null,
    });
    function Wrapper(props: { readonly children: ReactNode }): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      );
    }
    const rendered = renderHook(() => useProvidersMcpMutate(null, null), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await rendered.result.current.mutateAsync({
        ...params,
        mutation: { action: "toggleServer", name: "docs", enabled: false },
        suppressToast: true,
      });
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("U6: a mutation success keeps the checked status and tools on an unaffected row", async () => {
    const checked: ProviderMcpServer = {
      name: "checked",
      enabled: true,
      transport: { type: "http", url: "https://example.com/mcp", auth: null },
      status: "connected",
      statusSource: "probe",
      statusDetail: null,
      tools: [
        {
          name: "search",
          description: null,
          inputSchema: null,
          enabled: true,
          readOnly: false,
        },
      ],
      discoveryPending: false,
      instructions: null,
      configOnly: false,
      stdioDegraded: false,
    };
    const toggled: ProviderMcpServer = {
      ...checked,
      name: "toggled",
      enabled: false,
      status: "disconnected",
      statusSource: "none",
      tools: [],
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
          // The new host rebuilds the whole list and carries the cached
          // Check result for rows the write did not touch.
          "providers.nativeMutate": () => ({
            result: {
              ok: true,
              kind: "mcp",
              servers: [checked, { ...toggled, enabled: true }],
              notices: [],
              coverage: { complete: true, sources: [] },
            },
          }),
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    mockClientHolder.client = spine.createRequester(mockLocalHostEntry);
    const params = {
      providerId: "kilocode",
      scope: "global",
      workspaceRoot: null,
    } as const;
    const listKey = providersNativeQueryKeys.mcpList(
      mockLocalHostEntry.hostId,
      params,
    );
    queryClient.setQueryData<McpListData>(listKey, {
      servers: [checked, toggled],
      notices: [],
      coverage: null,
      refreshError: null,
    });
    function Wrapper(props: { readonly children: ReactNode }): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      );
    }
    const rendered = renderHook(() => useProvidersMcpMutate(null, null), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await rendered.result.current.mutateAsync({
        ...params,
        mutation: { action: "toggleServer", name: "toggled", enabled: true },
        suppressToast: true,
      });
    });
    const after = queryClient.getQueryData<McpListData>(listKey);
    const kept = after?.servers.find((row) => row.name === "checked");
    expect(kept?.status).toBe("connected");
    expect(kept?.statusSource).toBe("probe");
    expect(kept?.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(after?.servers.find((row) => row.name === "toggled")?.enabled).toBe(
      true,
    );
    expect(after?.coverage).toEqual({ complete: true, sources: [] });
  });

  describe("a typed refusal and an active list observer", () => {
    async function refuse(
      code: "server_not_found" | "duplicate_name",
    ): Promise<{ globalReads: number; projectReads: number; rows: string[] }> {
      const reads = { global: 0, project: 0, mutate: 0 };
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
              if (native?.kind !== "mcp") {
                return { providers: [], native: null };
              }
              if (native.scope === "global") reads.global += 1;
              else reads.project += 1;
              return {
                providers: [],
                native: {
                  ok: true,
                  kind: "mcp",
                  // The host drops the row once it is read again.
                  servers: reads.global > 1 ? [] : [staleRow("gone")],
                },
              };
            },
            "providers.nativeMutate": () => {
              reads.mutate += 1;
              return { result: { ok: false, code, detail: "Not changed." } };
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
          mutation: useProvidersMcpMutate(null, null),
        }),
        { wrapper: Wrapper },
      );
      await waitFor(() => {
        expect(observed.result.current.global.data?.servers).toHaveLength(1);
        expect(observed.result.current.project.data).toBeDefined();
      });
      expect(reads.global).toBe(1);
      expect(reads.project).toBe(1);

      await act(async () => {
        await observed.result.current.mutation
          .mutateAsync({
            providerId: "kilocode",
            scope: "global",
            workspaceRoot: null,
            mutation: { action: "toggleServer", name: "gone", enabled: true },
            suppressToast: true,
          })
          .catch(() => undefined);
      });
      expect(reads.mutate).toBe(1);
      // Only a refusal that proves the row is gone re-reads; wait on that
      // outcome, not on time. Any other refusal invalidates nothing.
      if (code === "server_not_found") {
        await waitFor(() =>
          expect(observed.result.current.global.data?.servers).toHaveLength(0),
        );
      }
      return {
        globalReads: reads.global,
        projectReads: reads.project,
        rows: (observed.result.current.global.data?.servers ?? []).map(
          (server) => server.name,
        ),
      };
    }

    it("server_not_found makes one complete read of the matching scope only, with the toast suppressed", async () => {
      const result = await refuse("server_not_found");
      expect(result.globalReads).toBe(2);
      expect(result.projectReads).toBe(1);
      expect(result.rows).toEqual([]);
    });

    it("duplicate_name triggers no read and keeps the seeded row", async () => {
      const result = await refuse("duplicate_name");
      expect(result.globalReads).toBe(1);
      expect(result.projectReads).toBe(1);
      expect(result.rows).toEqual(["gone"]);
    });
  });
});
