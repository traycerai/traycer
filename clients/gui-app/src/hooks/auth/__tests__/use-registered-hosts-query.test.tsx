// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type {
  HostListItem,
  HostListResponse,
} from "@traycer/protocol/host/host-status";
import type { AuthService } from "@/lib/auth/auth-service";
import type { HostDirectoryService } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

const currentAuthEra = vi.fn<() => AuthEra>();
const fetchRegisteredHosts =
  vi.fn<(era: AuthEra) => Promise<HostListResponse | null>>();

const auth = { currentAuthEra, fetchRegisteredHosts } as Pick<
  AuthService,
  "currentAuthEra" | "fetchRegisteredHosts"
>;
const directory = {} as Pick<HostDirectoryService, never>;

// Mutable so the binding can be swapped between renders, mirroring the
// deregister-mutation test's approach to driving `useHostBinding`.
const bindingRef: { value: unknown } = { value: { auth, directory } };

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingRef.value,
}));

import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function hostItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: "My Host",
    platform: "darwin",
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.1.10",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
    updatePolicy: "manual",
  };
}

const userAProfile = {
  userId: "user-a",
  userName: "User A",
  email: "a@example.com",
};
const userBProfile = {
  userId: "user-b",
  userName: "User B",
  email: "b@example.com",
};

describe("useRegisteredHosts", () => {
  beforeEach(() => {
    currentAuthEra.mockReset();
    fetchRegisteredHosts.mockReset();
    bindingRef.value = { auth, directory };
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
      shareableTeams: [],
      subscriptionStatus: null,
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
      shareableTeams: [],
      subscriptionStatus: null,
    });
  });

  it("keys the cache to the signed-in identity, so one account's hosts are never served to its replacement", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    useAuthStore.setState({
      status: "signed-in",
      profile: userAProfile,
      contextMetadata: { userId: "user-a", username: "a" },
    });
    currentAuthEra.mockReturnValue({
      identity: "user-a",
      credentialGeneration: 1,
    });
    const userAHosts: HostListResponse = { hosts: [hostItem("host-a")] };
    fetchRegisteredHosts.mockResolvedValue(userAHosts);

    const { result, rerender } = renderHook(() => useRegisteredHosts(), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(userAHosts));

    // Switch to a different signed-in account. The bearer/era rotate to
    // user-b, and the registry fetch for user-b never resolves — the only
    // way `data` could show a host list is if the (unkeyed) cache entry from
    // user-a leaked through.
    useAuthStore.setState({
      status: "signed-in",
      profile: userBProfile,
      contextMetadata: { userId: "user-b", username: "b" },
    });
    currentAuthEra.mockReturnValue({
      identity: "user-b",
      credentialGeneration: 2,
    });
    fetchRegisteredHosts.mockImplementation(
      () => new Promise<HostListResponse | null>(() => undefined),
    );

    rerender();

    await waitFor(() => expect(fetchRegisteredHosts).toHaveBeenCalled());
    expect(result.current.data).toBeUndefined();
  });

  it("keeps the last successful host list when the registry 401s a still-current bearer", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    useAuthStore.setState({
      status: "signed-in",
      profile: userAProfile,
      contextMetadata: { userId: "user-a", username: "a" },
    });
    currentAuthEra.mockReturnValue({
      identity: "user-a",
      credentialGeneration: 1,
    });
    const userAHosts: HostListResponse = { hosts: [hostItem("host-a")] };
    fetchRegisteredHosts.mockResolvedValue(userAHosts);

    const { result } = renderHook(() => useRegisteredHosts(), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(userAHosts));

    // Bearer is still user-a's, but the registry 401s the refresh — modeled
    // by AuthService's unauthorized -> null contract.
    fetchRegisteredHosts.mockResolvedValue(null);

    act(() => {
      void result.current.refetch();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toEqual(userAHosts);
  });
});
