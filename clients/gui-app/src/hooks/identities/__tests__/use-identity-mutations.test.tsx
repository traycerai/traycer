/**
 * The Hermes importer's two mutations, driven through a REAL `HostClient` over
 * a mock messenger so the error path is the wire's own `HostRpcError`:
 *
 * - finding 47: the panel renders every rejection inline, so no wire code
 *   toasts beside it - not only `RPC_ERROR`;
 * - finding 48: a run replaces files in an existing identity and retains the
 *   prior versions, so it invalidates the history read as well as the list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import type { ReactNode } from "react";
import { toast } from "sonner";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import type {
  AgentIdentityHermesRunResponse,
  AgentIdentityHermesScanResponse,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  useIdentityHermesRunForClient,
  useIdentityHermesScanForClient,
} from "@/hooks/identities/use-identity-mutations";

const HOST_ID = mockLocalHostEntry.hostId;

function rpcError(code: RpcErrorCode, method: string): HostRpcError {
  return new HostRpcError({
    code,
    message: `${method} failed with ${code}`,
    requestId: "req-1",
    method,
    fatalDetails: null,
  });
}

const IMPORTED: AgentIdentityHermesRunResponse = {
  kind: "imported",
  identity: {
    identityId: "identity_1",
    title: "Hermes (acme)",
    description: null,
    updatedAt: 0,
  },
  items: [],
};

function buildClient(args: {
  readonly onScan: () => AgentIdentityHermesScanResponse;
  readonly onRun: () => AgentIdentityHermesRunResponse;
}): HostClient<HostRpcRegistry> {
  let requestCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String((requestCount += 1))}`,
      handlers: {
        "agentIdentity.import.hermes.scan": args.onScan,
        "agentIdentity.import.hermes.run": args.onRun,
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
});

describe("useIdentityHermesScanForClient / useIdentityHermesRunForClient - inline errors (finding 47)", () => {
  it.each<RpcErrorCode>(["UNAUTHORIZED", "FORBIDDEN", "RPC_ERROR"])(
    "does not toast a %s rejection: the panel renders it inline",
    async (code) => {
      const client = buildClient({
        onScan: () => {
          throw rpcError(code, "agentIdentity.import.hermes.scan");
        },
        onRun: () => {
          throw rpcError(code, "agentIdentity.import.hermes.run");
        },
      });
      const queryClient = new QueryClient();
      const { result } = renderHook(
        () => ({
          scan: useIdentityHermesScanForClient(client),
          run: useIdentityHermesRunForClient(client),
        }),
        { wrapper: wrapperFor(queryClient) },
      );

      await expect(
        result.current.scan.mutateAsync({ directory: "~/.hermes" }),
      ).rejects.toBeInstanceOf(HostRpcError);
      await expect(
        result.current.run.mutateAsync({
          directory: "~/.hermes",
          identityId: null,
          title: "Hermes",
          selectedRelPaths: ["SOUL.md"],
        }),
      ).rejects.toBeInstanceOf(HostRpcError);

      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});

describe("useIdentityHermesRunForClient - invalidations (finding 48)", () => {
  it("invalidates the history read as well as the list on a successful run", async () => {
    const client = buildClient({
      onScan: () => ({ kind: "notAProfile", detail: "unused" }),
      onRun: () => IMPORTED,
    });
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useIdentityHermesRunForClient(client), {
      wrapper: wrapperFor(queryClient),
    });

    await expect(
      result.current.mutateAsync({
        directory: "~/.hermes",
        identityId: "identity_1",
        title: null,
        selectedRelPaths: ["SOUL.md"],
      }),
    ).resolves.toEqual(IMPORTED);

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope(
          HOST_ID,
          "agentIdentity.history.list",
        ),
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "agentIdentity.list"),
    });
  });
});
