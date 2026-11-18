import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { WORKTREE_DIRECTORY_CHECK_TIMEOUT_MESSAGE } from "@traycer/protocol/host/worktree-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  HostRpcError,
  RetryableTransportError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useTerminalWorkspaceBindingsForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";

type BindingsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listBindingsForEpic"
>;

function response(pending: boolean): BindingsResponse {
  return {
    rows: [
      {
        hostId: "host-1",
        runningDir: "/workspace/plain-folder",
        workspacePath: "/workspace/plain-folder",
        worktreePath: null,
        mode: "local",
        isGitRepo: false,
        repoIdentifier: null,
        branch: null,
        isPrimary: true,
        isImported: false,
        setupState: "not_required",
        disabledReason: pending ? "missing_worktree_path" : null,
        isGitResolvePending: pending,
        sources: [],
      },
    ],
    folderlessCwd: null,
  };
}

function partialResponse(): BindingsResponse {
  const unresolved = response(true).rows[0];
  const verified = response(false).rows[0];
  return {
    rows: [
      { ...verified, hostId: "host-verified" },
      { ...unresolved, hostId: "host-unresolved" },
    ],
    folderlessCwd: null,
  };
}

describe("useTerminalWorkspaceBindingsForClient", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("requests directory availability and retries an old-host pending response", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
    let responseCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `terminal-${String(responseCount + 1)}`,
      handlers: {
        "worktree.listBindingsForEpic": (params) => {
          expect(params).toEqual({
            epicId: "epic-1",
            purpose: "directory",
          });
          responseCount += 1;
          return response(responseCount < 3);
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const rendered = renderHook(
      () =>
        useTerminalWorkspaceBindingsForClient({
          client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(responseCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(responseCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(responseCount).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(responseCount).toBe(3);
    expect(rendered.result.current.data).toEqual(response(false));
    expect(rendered.result.current.error).toBeNull();
  });

  it("does not spend the UI retry budget on an exhausted transport failure", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let requestCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "terminal-transport",
      handlers: {
        "worktree.listBindingsForEpic": () => {
          requestCount += 1;
          throw new RetryableTransportError({
            replaySafetyFromKey: false,
            code: "RPC_ERROR",
            message: "dial exhausted",
            requestId: "terminal-transport",
            method: "worktree.listBindingsForEpic",
            fatalDetails: null,
          });
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const rendered = renderHook(
      () =>
        useTerminalWorkspaceBindingsForClient({
          client,
          epicId: "epic-transport",
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requestCount).toBe(1);
    expect(rendered.result.current.error).toBeInstanceOf(
      RetryableTransportError,
    );
  });

  it("does not retry an unrelated host RPC error", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let requestCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "terminal-unrelated-error",
      handlers: {
        "worktree.listBindingsForEpic": () => {
          requestCount += 1;
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "workspace lookup failed",
            requestId: "terminal-unrelated-error",
            method: "worktree.listBindingsForEpic",
            fatalDetails: null,
          });
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const rendered = renderHook(
      () =>
        useTerminalWorkspaceBindingsForClient({
          client,
          epicId: "epic-unrelated-error",
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestCount).toBe(1);
    expect(rendered.result.current.error).toBeInstanceOf(HostRpcError);
  });

  it("keeps verified siblings when another directory is unavailable, then recovers on refetch", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let requestCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `terminal-partial-${String(requestCount + 1)}`,
      handlers: {
        "worktree.listBindingsForEpic": () => {
          requestCount += 1;
          return requestCount === 1 ? partialResponse() : response(false);
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const rendered = renderHook(
      () =>
        useTerminalWorkspaceBindingsForClient({
          client,
          epicId: "epic-partial",
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestCount).toBe(1);
    expect(rendered.result.current.isError).toBe(false);
    expect(rendered.result.current.data?.rows).toHaveLength(2);
    expect(
      rendered.result.current.data?.rows.find(
        (row) => row.hostId === "host-verified",
      )?.disabledReason,
    ).toBeNull();

    await act(async () => {
      await rendered.result.current.refetch({ cancelRefetch: false });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requestCount).toBe(2);
    expect(rendered.result.current.data).toEqual(response(false));
    expect(rendered.result.current.error).toBeNull();
  });

  it("rechecks directory availability when the hook remounts", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 60_000,
          staleTime: 60_000,
          refetchOnMount: false,
        },
      },
    });
    let requestCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `terminal-remount-${String(requestCount + 1)}`,
      handlers: {
        "worktree.listBindingsForEpic": () => {
          requestCount += 1;
          return response(false);
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const useRemountBindings = () =>
      useTerminalWorkspaceBindingsForClient({
        client,
        epicId: "epic-remount",
        enabled: true,
      });
    const first = renderHook(useRemountBindings, { wrapper: Wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestCount).toBe(1);
    first.unmount();

    renderHook(useRemountBindings, { wrapper: Wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestCount).toBe(2);
  });

  it("caps unresolved responses, then recovers through manual refetch", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let requestCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `terminal-manual-${String(requestCount + 1)}`,
      handlers: {
        "worktree.listBindingsForEpic": () => {
          requestCount += 1;
          if (requestCount < 4) {
            throw new HostRpcError({
              code: "RPC_ERROR",
              message: WORKTREE_DIRECTORY_CHECK_TIMEOUT_MESSAGE,
              requestId: `terminal-timeout-${String(requestCount)}`,
              method: "worktree.listBindingsForEpic",
              fatalDetails: null,
            });
          }
          return response(false);
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const rendered = renderHook(
      () =>
        useTerminalWorkspaceBindingsForClient({
          client,
          epicId: "epic-manual",
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requestCount).toBe(3);
    expect(rendered.result.current.isError).toBe(true);

    await act(async () => {
      await rendered.result.current.refetch();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requestCount).toBe(4);
    expect(rendered.result.current.data).toEqual(response(false));
    expect(rendered.result.current.error).toBeNull();
  });
});
