import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

const mocks = vi.hoisted(() => ({
  defaultRequest: vi.fn(),
  transientRequest: vi.fn(() => Promise.resolve({ killed: true })),
  buildTransientHostClient: vi.fn(),
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
  useHostDirectory: () => ({ findById: () => hostA }),
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
  afterEach(() => {
    cleanup();
    mocks.defaultRequest.mockReset();
    mocks.transientRequest.mockClear();
    mocks.buildTransientHostClient.mockReset();
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
});
