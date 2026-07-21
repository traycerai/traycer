import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ReactNode } from "react";
import { queryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Closes T2 review P3-2: prove `useRefreshProvidersListOnTurnDefaultHost`
 * invalidates the same providers.list query key that
 * `useProvidersListForClient` → `useHostQuery` populate for the default host.
 *
 * Both sides build `queryKeys.hostMethod(hostId, "providers.list", {})` —
 * the list reader with `readiness.hostId` from the default HostClient, the
 * refresh hook with `useReactiveActiveHostId()` (same active-host source).
 *
 * Real primitives: real QueryClient, real default-host wrapper, real
 * `useRefreshProvidersListOnTurn`. Fake only external boundaries:
 * - reactive default host id (host runtime)
 * - chat turn-completion subscription (session bus)
 */

const mocks = vi.hoisted(() => {
  const state: {
    defaultHostId: string | null;
    turnHandler: null | ((completion: { harnessId: GuiHarnessId }) => void);
  } = {
    defaultHostId: "default-host-a",
    turnHandler: null,
  };
  return state;
});

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mocks.defaultHostId,
}));

vi.mock("@/lib/chats/chat-turn-completions", () => ({
  subscribeChatTurnCompletions: (
    cb: (completion: { harnessId: GuiHarnessId }) => void,
  ) => {
    mocks.turnHandler = cb;
    return () => {
      mocks.turnHandler = null;
    };
  },
}));

import { useRefreshProvidersListOnTurnDefaultHost } from "@/hooks/providers/use-refresh-providers-list-on-turn-default-host";

function fireTurn(harnessId: GuiHarnessId): void {
  act(() => {
    mocks.turnHandler?.({ harnessId });
  });
}

function providersListQueryKey(hostId: string | null) {
  return queryKeys.hostMethod<HostRpcRegistry, "providers.list">(
    hostId,
    "providers.list",
    {},
  );
}

describe("useRefreshProvidersListOnTurnDefaultHost cache-key coherence", () => {
  beforeEach(() => {
    mocks.defaultHostId = "default-host-a";
    mocks.turnHandler = null;
  });
  afterEach(() => {
    cleanup();
  });

  it("invalidates the same providers.list key useProvidersListForClient uses for the reactive default host", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const defaultHostKey = providersListQueryKey(mocks.defaultHostId);
    // Seed the cache the way a settled useHostQuery entry looks - the
    // invalidator must address this exact key, not a sibling host scope.
    queryClient.setQueryData(defaultHostKey, {
      providers: [],
    });
    const otherHostKey = providersListQueryKey("other-host-b");
    queryClient.setQueryData(otherHostKey, {
      providers: [],
    });

    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // Mount the default-host refresh hook (production landing path).
    renderHook(() => useRefreshProvidersListOnTurnDefaultHost("claude"), {
      wrapper,
    });

    // The key builders must agree before we even fire a turn - this is the
    // contract useProvidersListForClient / useHostQuery rely on for the
    // default host (hostId from readiness / getActiveHostId).
    expect(defaultHostKey).toEqual([
      "host",
      "default-host-a",
      "providers.list",
      {},
    ]);

    fireTurn("claude");

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: defaultHostKey,
    });
    // Sibling host scope must not be targeted.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: otherHostKey,
    });
  });

  it("tracks a host swap: invalidation follows the new reactive default host id", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { rerender } = renderHook(
      () => useRefreshProvidersListOnTurnDefaultHost("claude"),
      { wrapper },
    );

    fireTurn("claude");
    expect(invalidateSpy).toHaveBeenLastCalledWith({
      queryKey: providersListQueryKey("default-host-a"),
    });

    mocks.defaultHostId = "default-host-b";
    rerender();
    // Host/harness effect reset clears the cooldown; a new matching turn must
    // invalidate the *new* host's providers.list key.
    fireTurn("claude");
    expect(invalidateSpy).toHaveBeenLastCalledWith({
      queryKey: providersListQueryKey("default-host-b"),
    });
  });

  it("agrees with the key shape useProvidersListForClient would request for a null default host", () => {
    mocks.defaultHostId = null;
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useRefreshProvidersListOnTurnDefaultHost("claude"), {
      wrapper,
    });
    fireTurn("claude");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: providersListQueryKey(null),
    });
    // Sanity: the public key builder used by the list query is identical.
    expect(providersListQueryKey(null)).toEqual(["host", "providers.list", {}]);
  });
});
