import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
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
          return response(requestCount < 4);
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
