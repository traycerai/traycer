import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderMcpServer,
  ProviderNativeErrorResult,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  isProviderNativeRpcError,
  mapProvidersListToMcpServers,
  mapSetEnabledToMcpMutate,
  mapStartLoginToMcpAuth,
} from "@/hooks/providers/native-response-map";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import {
  nativeMcpListParams,
  providersNativeQueryKeys,
} from "@/lib/query-keys/providers-native-query-keys";

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return {
    ...actual,
    useHostClient: () => mockClientHolder.client,
  };
});

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostClient<HostRpcRegistry> | null) => ({
    hostId: client?.getActiveHostId() ?? null,
    isReady: client !== null && client.getActiveHostId() !== null,
  }),
}));

const mockClientHolder: {
  client: HostClient<HostRpcRegistry> | null;
} = { client: null };

const EMPTY_SERVER: ProviderMcpServer = {
  name: "ctx",
  enabled: true,
  transport: { type: "http", url: "https://example.com", auth: null },
  status: "connected",
  statusSource: "probe",
  statusDetail: null,
  tools: [
    {
      name: "t1",
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

function stubProviderState(): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    selected: { kind: "path" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["mcp"],
      mcp: null,
      plugins: null,
      skills: null,
    },
    profiles: [],
  };
}

function createFixture(handlers: {
  list: (
    params: RequestOfMethod<HostRpcRegistry, "providers.list">,
  ) =>
    | ResponseOfMethod<HostRpcRegistry, "providers.list">
    | Promise<ResponseOfMethod<HostRpcRegistry, "providers.list">>;
  setEnabled:
    | ((
        params: RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
      ) =>
        | ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">
        | Promise<ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">>)
    | undefined;
}) {
  const queryClient = createAppQueryClient();
  const listCalls: unknown[] = [];
  const setEnabledCalls: unknown[] = [];
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": (params) => {
          listCalls.push(params);
          return handlers.list(params);
        },
        "providers.setEnabled": (params) => {
          setEnabledCalls.push(params);
          if (handlers.setEnabled === undefined) {
            throw new Error("setEnabled not mocked");
          }
          return handlers.setEnabled(params);
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mockClientHolder.client = client;

  function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }

  return {
    queryClient,
    client,
    listCalls,
    setEnabledCalls,
    Wrapper,
    hostId: mockLocalHostEntry.hostId,
  };
}

afterEach(() => {
  cleanup();
  mockClientHolder.client = null;
});

describe("native response mappers", () => {
  it("maps mcp list success and treats typed empty as empty servers", () => {
    expect(
      mapProvidersListToMcpServers({
        response: {
          providers: [],
          native: { ok: true, kind: "mcp", servers: [] },
        },
      }),
    ).toEqual({ servers: [] });
  });

  it("throws ProviderNativeRpcError on ok:false native result", () => {
    const err: ProviderNativeErrorResult = {
      ok: false,
      code: "duplicate_name",
      detail: "already exists",
    };
    expect(() =>
      mapSetEnabledToMcpMutate({
        response: {
          state: stubProviderState(),
          native: err,
        },
      }),
    ).toThrow(expect.objectContaining({ nativeCode: "duplicate_name" }));
  });

  it("maps startLogin mcpAuth authorizationUrl", () => {
    expect(
      mapStartLoginToMcpAuth({
        response: {
          url: "https://auth.example",
          started: true,
          mcpAuth: {
            kind: "authorizationUrl",
            authorizationUrl: "https://auth.example",
          },
          profileId: null,
        },
      }),
    ).toEqual({
      result: {
        kind: "authorizationUrl",
        authorizationUrl: "https://auth.example",
      },
    });
  });
});

describe("useProvidersMcpList fold", () => {
  it("calls providers.list with native mcp query and semantic key", async () => {
    const fixture = createFixture({
      list: (params) => {
        expect(params.native).toMatchObject({
          kind: "mcp",
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
        });
        return {
          providers: [],
          native: {
            ok: true,
            kind: "mcp",
            servers: [EMPTY_SERVER],
          },
        };
      },
      setEnabled: undefined,
    });

    const rendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.data?.servers).toHaveLength(1);
    });
    expect(fixture.listCalls).toHaveLength(1);

    const key = providersNativeQueryKeys.mcpList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });
    expect(fixture.queryClient.getQueryData(key)).toEqual({
      servers: [EMPTY_SERVER],
    });
    const classicKey = [
      "host",
      fixture.hostId,
      "providers.list",
      { native: null },
    ];
    expect(fixture.queryClient.getQueryData(classicKey)).toBeUndefined();
  });

  it("does not send when enabled is false (feature-detect gate)", async () => {
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "mcp", servers: [] },
      }),
      setEnabled: undefined,
    });

    renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: false,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(fixture.listCalls).toHaveLength(0);
  });
});

describe("useProvidersMcpMutate fold", () => {
  it("sends setEnabled native arm and writes list cache", async () => {
    const updated = { ...EMPTY_SERVER, enabled: false };
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "mcp", servers: [EMPTY_SERVER] },
      }),
      setEnabled: (params) => {
        expect(params.enabled).toBeNull();
        expect(params.native).toMatchObject({
          kind: "mcp",
          mutation: {
            action: "toggleServer",
            name: "ctx",
            enabled: false,
          },
        });
        return {
          state: stubProviderState(),
          native: { ok: true, kind: "mcp", servers: [updated] },
        };
      },
    });

    const listRendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(listRendered.result.current.data?.servers[0]?.enabled).toBe(true);
    });

    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });

    await act(async () => {
      await mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "ctx", enabled: false },
        suppressToast: undefined,
      });
    });

    expect(fixture.setEnabledCalls).toHaveLength(1);
    await waitFor(() => {
      expect(listRendered.result.current.data?.servers[0]?.enabled).toBe(false);
    });
  });

  it("rolls back optimistic toggle on native error", async () => {
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "mcp", servers: [EMPTY_SERVER] },
      }),
      setEnabled: () => ({
        state: stubProviderState(),
        native: {
          ok: false,
          code: "no_change_detected",
          detail: "unchanged",
        },
      }),
    });

    const listRendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(listRendered.result.current.data?.servers).toHaveLength(1);
    });

    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await mutateRendered.result.current.mutateAsync({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          mutation: { action: "toggleServer", name: "ctx", enabled: false },
          suppressToast: undefined,
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(isProviderNativeRpcError(thrown)).toBe(true);
    if (isProviderNativeRpcError(thrown)) {
      expect(thrown.nativeCode).toBe("no_change_detected");
    }
    await waitFor(() => {
      expect(listRendered.result.current.data?.servers[0]?.enabled).toBe(true);
    });
  });
});

describe("native list params", () => {
  it("builds distinct wire params for classic vs native", () => {
    expect(
      nativeMcpListParams({
        providerId: "codex",
        scope: "project",
        workspaceRoot: "/ws",
      }),
    ).toEqual({
      native: {
        kind: "mcp",
        providerId: "codex",
        scope: "project",
        workspaceRoot: "/ws",
      },
    });
  });
});
