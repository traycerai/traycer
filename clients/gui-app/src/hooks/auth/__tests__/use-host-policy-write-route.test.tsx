import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SandboxListFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { sandboxQueryKeys } from "@/lib/query-keys";
import {
  resetHostDirectoryRows,
  sandboxHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostPolicyWriteRoute } from "@/hooks/auth/use-host-policy-write-route";

interface RouteTestBinding extends FakeSandboxBinding {
  readonly directory: FakeSandboxBinding["directory"] & {
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
  };
}

const bindingState = vi.hoisted<{ current: RouteTestBinding | null }>(() => ({
  current: null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => bindingState.current,
}));

const HOST_ID = "team-sandbox-host";
const SANDBOX_ID = "sandbox-row";

function makeBinding(): RouteTestBinding {
  const fixture = createFakeSandboxBinding();
  return {
    auth: fixture.auth,
    directory: {
      ...fixture.directory,
      findById: vi.fn<(hostId: string) => HostDirectoryEntry | null>(() =>
        sandboxHostEntry(HOST_ID, { id: "team-a", name: "Alpha" }),
      ),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
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

beforeEach(() => {
  bindingState.current = makeBinding();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user" },
  });
});

afterEach(() => {
  cleanup();
  resetHostDirectoryRows();
  bindingState.current = null;
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("useHostPolicyWriteRoute with the sandbox list query", () => {
  it("keeps a team sandbox route unknown until the first list answer", async () => {
    const binding = bindingState.current;
    if (binding === null) throw new Error("test setup has no binding");
    const pendingAnswer: {
      resolve: ((result: SandboxListFetchResult) => void) | null;
    } = { resolve: null };
    const pendingList = new Promise<SandboxListFetchResult>((resolve) => {
      pendingAnswer.resolve = resolve;
    });
    binding.auth.listSandboxes.mockImplementationOnce(() => pendingList);
    const queryClient = makeQueryClient();
    const rendered = renderHook(() => useHostPolicyWriteRoute(HOST_ID), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => {
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1);
    });
    expect(rendered.result.current).toEqual({ kind: "unknown" });
    const resolveList = pendingAnswer.resolve;
    if (resolveList === null) throw new Error("list read did not start");
    act(() => {
      resolveList({ kind: "ok", response: { sandboxes: [] } });
    });
    rendered.unmount();
    queryClient.clear();
  });

  it("keeps a team sandbox route unknown when the first list answer fails", async () => {
    const binding = bindingState.current;
    if (binding === null) throw new Error("test setup has no binding");
    binding.auth.listSandboxes.mockResolvedValueOnce({
      kind: "network-error",
      detail: "list unavailable",
    });
    const queryClient = makeQueryClient();
    const queryKey = sandboxQueryKeys.list(binding.auth, "user-1");
    const rendered = renderHook(() => useHostPolicyWriteRoute(HOST_ID), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(queryKey)?.status).toBe("error");
    });
    expect(rendered.result.current).toEqual({ kind: "unknown" });
    rendered.unmount();
    queryClient.clear();
  });

  it("keeps the listed route through a failed refetch, then denies it after a successful absence", async () => {
    const binding = bindingState.current;
    if (binding === null) throw new Error("test setup has no binding");
    binding.auth.listSandboxes
      .mockResolvedValueOnce({
        kind: "ok",
        response: {
          sandboxes: [
            sandboxSummaryFixture({ id: SANDBOX_ID, hostId: HOST_ID }),
          ],
        },
      })
      .mockResolvedValueOnce({ kind: "network-error", detail: "offline" })
      .mockResolvedValueOnce({
        kind: "ok",
        response: { sandboxes: [] },
      });
    const queryClient = makeQueryClient();
    const queryKey = sandboxQueryKeys.list(binding.auth, "user-1");
    const rendered = renderHook(() => useHostPolicyWriteRoute(HOST_ID), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => {
      expect(rendered.result.current).toEqual({
        kind: "sandbox",
        sandboxId: SANDBOX_ID,
      });
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey });
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(queryKey)?.error).not.toBeNull();
    });
    expect(rendered.result.current).toEqual({
      kind: "sandbox",
      sandboxId: SANDBOX_ID,
    });

    await act(async () => {
      await queryClient.refetchQueries({ queryKey });
    });
    await waitFor(() => {
      expect(rendered.result.current).toEqual({ kind: "denied" });
    });
    rendered.unmount();
    queryClient.clear();
  });
});
