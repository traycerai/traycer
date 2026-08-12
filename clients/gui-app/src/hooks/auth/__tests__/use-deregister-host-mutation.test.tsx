// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeregisterHostFetchResult } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import type { AuthService } from "@/lib/auth/auth-service";
import type { HostDirectoryService } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";

const deregisterHostFromAccount =
  vi.fn<(hostId: string) => Promise<DeregisterHostFetchResult>>();
const refresh = vi.fn<() => Promise<readonly []>>();

const auth = { deregisterHostFromAccount } as Pick<
  AuthService,
  "deregisterHostFromAccount"
>;
const directory = { refresh } as Pick<HostDirectoryService, "refresh">;

// Mutable so one test can prove the mutation uses its ARM-TIME capture rather
// than whatever the binding became while the request was in flight.
const bindingRef: { value: unknown } = { value: { auth, directory } };

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingRef.value,
}));

import { useDeregisterHostFromAccount } from "@/hooks/auth/use-deregister-host-mutation";

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useDeregisterHostFromAccount", () => {
  beforeEach(() => {
    deregisterHostFromAccount.mockReset();
    refresh.mockReset();
    refresh.mockResolvedValue([]);
    bindingRef.value = { auth, directory };
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * The settings host list is a UNION of the registry query and the runtime
   * directory's own cached entries (`buildHostScopeOptions`). Invalidating only
   * the registry leaves the removed host on screen as a directory-only row
   * until the directory's ~15s poll - a row that outlives the success toast
   * reads as a removal that did not happen.
   */
  it("refreshes the runtime directory as well as the registry query", async () => {
    deregisterHostFromAccount.mockResolvedValue({ kind: "ok" });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useDeregisterHostFromAccount("host-b"),
      { wrapper: wrapperFor(queryClient) },
    );
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHosts(auth as AuthService),
    });
  });

  it("refreshes the caches it armed against, not the ones the binding moved to", async () => {
    const otherRefresh = vi.fn<() => Promise<readonly []>>();
    otherRefresh.mockResolvedValue([]);
    let release = (): void => undefined;
    deregisterHostFromAccount.mockImplementation(
      async (): Promise<DeregisterHostFetchResult> => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { kind: "ok" };
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { result } = renderHook(
      () => useDeregisterHostFromAccount("host-b"),
      { wrapper: wrapperFor(queryClient) },
    );
    result.current.mutate();
    await waitFor(() => expect(result.current.isPending).toBe(true));

    // The scope moves while the removal is in flight.
    bindingRef.value = { auth, directory: { refresh: otherRefresh } };
    release();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(otherRefresh).not.toHaveBeenCalled();
  });

  /**
   * A 404 means the host is already off the account - the user's intent holds,
   * so it resolves rather than throwing, and the caches still have to catch up.
   */
  it("treats an already-removed host as success and still refreshes", async () => {
    deregisterHostFromAccount.mockResolvedValue({ kind: "not-found" });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { result } = renderHook(
      () => useDeregisterHostFromAccount("host-b"),
      { wrapper: wrapperFor(queryClient) },
    );
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves both caches alone when the removal is refused", async () => {
    deregisterHostFromAccount.mockResolvedValue({ kind: "revoked" });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useDeregisterHostFromAccount("host-b"),
      { wrapper: wrapperFor(queryClient) },
    );
    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(refresh).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
