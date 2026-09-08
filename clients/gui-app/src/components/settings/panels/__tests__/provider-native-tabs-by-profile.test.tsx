import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";

/**
 * D17: every native list/mutate call carries `profileId: string | null` as a
 * required field, and `null` (the Default account) rides as an explicit key
 * rather than an omitted one - a downgrade bridge or a host-side default that
 * treats "missing" as "ambient" is exactly the silent-write-to-Default bug
 * this refactor exists to remove.
 */

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: mockLocalHostEntry.hostId,
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

const mockClientHolder: { client: HostClient<HostRpcRegistry> | null } = {
  client: null,
};

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return {
    ...actual,
    useHostClient: () => mockClientHolder.client,
  };
});

function createFixture(handlers: {
  list: (
    params: RequestOfMethod<HostRpcRegistry, "providers.list">,
  ) => ResponseOfMethod<HostRpcRegistry, "providers.list">;
  nativeMutate: (
    params: RequestOfMethod<HostRpcRegistry, "providers.nativeMutate">,
  ) => ResponseOfMethod<HostRpcRegistry, "providers.nativeMutate">;
}) {
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
        "providers.list": (params) => handlers.list(params),
        "providers.nativeMutate": (params) => handlers.nativeMutate(params),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  mockClientHolder.client = client;

  function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }

  return { queryClient, Wrapper, hostId: mockLocalHostEntry.hostId };
}

afterEach(() => {
  cleanup();
  mockClientHolder.client = null;
});

describe("native list/mutate hooks carry profileId (D17)", () => {
  it("two different profileIds produce two different query keys and two separate RPCs", async () => {
    const seenProfileIds: Array<string | null> = [];
    const fixture = createFixture({
      list: (params) => {
        if (params.native !== null && params.native.kind === "mcp") {
          seenProfileIds.push(params.native.profileId);
        }
        return {
          providers: [],
          native: { ok: true, kind: "mcp", servers: [] },
        };
      },
      nativeMutate: () => {
        throw new Error("not exercised in this test");
      },
    });

    const first = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          profileId: "profile-a",
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(first.result.current.data?.servers).toEqual([]);
    });

    const second = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          profileId: "profile-b",
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(second.result.current.data?.servers).toEqual([]);
    });

    expect(seenProfileIds).toEqual(["profile-a", "profile-b"]);

    const keyA = providersNativeQueryKeys.mcpList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      profileId: "profile-a",
    });
    const keyB = providersNativeQueryKeys.mcpList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      profileId: "profile-b",
    });
    expect(keyA).not.toEqual(keyB);
  });

  it("profileId: null rides as an explicit field, never an omitted one", async () => {
    let capturedProfileId: string | null | undefined;
    const fixture = createFixture({
      list: (params) => {
        if (params.native !== null && params.native.kind === "mcp") {
          capturedProfileId = params.native.profileId;
        }
        return {
          providers: [],
          native: { ok: true, kind: "mcp", servers: [] },
        };
      },
      nativeMutate: () => {
        throw new Error("not exercised in this test");
      },
    });

    const rendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          profileId: null,
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(rendered.result.current.data?.servers).toEqual([]);
    });

    expect(capturedProfileId).toBeNull();
  });

  it("an MCP mutation sends profileId on providers.nativeMutate", async () => {
    let capturedProfileId: string | null | undefined;
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "mcp", servers: [] },
      }),
      nativeMutate: (params) => {
        capturedProfileId = params.profileId;
        return {
          result: { ok: true, kind: "mcp", servers: [] },
        };
      },
    });

    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });

    await act(async () => {
      await mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        profileId: "profile-a",
        mutation: { action: "toggleServer", name: "srv", enabled: false },
        suppressToast: true,
      });
    });

    expect(capturedProfileId).toBe("profile-a");
  });

  it("project scope still sends profileId (no client-side branch)", async () => {
    let capturedProfileId: string | null | undefined;
    const fixture = createFixture({
      list: (params) => {
        if (params.native !== null && params.native.kind === "mcp") {
          capturedProfileId = params.native.profileId;
        }
        return {
          providers: [],
          native: { ok: true, kind: "mcp", servers: [] },
        };
      },
      nativeMutate: () => {
        throw new Error("not exercised in this test");
      },
    });

    const rendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "project",
          workspaceRoot: "/repo",
          profileId: "profile-a",
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(rendered.result.current.data?.servers).toEqual([]);
    });

    expect(capturedProfileId).toBe("profile-a");
  });
});
