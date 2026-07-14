import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

const mocks = vi.hoisted(() => ({
  defaultRequest: vi.fn(),
  transientRequest: vi.fn(() => Promise.resolve({ killed: true })),
  buildTransientHostClient: vi.fn(),
  findById: vi.fn(),
}));

const hostA: HostDirectoryEntry = {
  hostId: "host-a",
  label: "Host A",
  kind: "remote",
  websocketUrl: "ws://host-a/rpc",
  version: "1.0.0",
  status: "available",
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => "host-a",
    request: mocks.defaultRequest,
  }),
  useHostDirectory: () => ({ findById: mocks.findById }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildTransientHostClient: mocks.buildTransientHostClient,
}));

import { useLandingTerminalKill } from "@/components/home/terminal-panel/use-landing-terminal-kill-mutation";

function QueryWrapper(props: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useLandingTerminalKill", () => {
  beforeEach(() => {
    mocks.findById.mockReturnValue(hostA);
  });

  afterEach(() => {
    cleanup();
    mocks.defaultRequest.mockReset();
    mocks.transientRequest.mockClear();
    mocks.buildTransientHostClient.mockReset();
    mocks.findById.mockReset();
  });

  it("pins a kill to the tab host even when that host is currently selected", async () => {
    mocks.buildTransientHostClient.mockReturnValue({
      request: mocks.transientRequest,
    });
    const { result } = renderHook(() => useLandingTerminalKill(), {
      wrapper: QueryWrapper,
    });

    await result.current.mutateAsync({
      hostId: "host-a",
      sessionId: "session-a",
    });

    expect(mocks.buildTransientHostClient).toHaveBeenCalledWith(
      expect.anything(),
      hostA,
    );
    expect(mocks.transientRequest).toHaveBeenCalledWith("terminal.kill", {
      sessionId: "session-a",
    });
    expect(mocks.defaultRequest).not.toHaveBeenCalled();
  });

  // Both ways of failing to resolve the tab's host. Neither may degrade into
  // "kill this session id on whatever host is handy" - a kill is destructive and
  // session ids are not host-unique, so a fallback could destroy a stranger's
  // PTY. Failing the mutation is the only safe outcome: the tombstone survives
  // and reconciliation retries once the real host is reachable again.
  it("fails the kill instead of falling back when the tab's host has left the directory", async () => {
    mocks.findById.mockReturnValue(null);
    const { result } = renderHook(() => useLandingTerminalKill(), {
      wrapper: QueryWrapper,
    });

    await expect(
      result.current.mutateAsync({ hostId: "host-a", sessionId: "session-a" }),
    ).rejects.toThrow("Host client unavailable");

    expect(mocks.buildTransientHostClient).not.toHaveBeenCalled();
    expect(mocks.transientRequest).not.toHaveBeenCalled();
    expect(mocks.defaultRequest).not.toHaveBeenCalled();
  });

  it("fails the kill instead of falling back when the tab's host has no routable client", async () => {
    // The entry exists but cannot be dialled - no websocket URL, or signed out.
    mocks.buildTransientHostClient.mockReturnValue(null);
    const { result } = renderHook(() => useLandingTerminalKill(), {
      wrapper: QueryWrapper,
    });

    await expect(
      result.current.mutateAsync({ hostId: "host-a", sessionId: "session-a" }),
    ).rejects.toThrow("Host client unavailable");

    expect(mocks.buildTransientHostClient).toHaveBeenCalledWith(
      expect.anything(),
      hostA,
    );
    expect(mocks.transientRequest).not.toHaveBeenCalled();
    expect(mocks.defaultRequest).not.toHaveBeenCalled();
  });
});
