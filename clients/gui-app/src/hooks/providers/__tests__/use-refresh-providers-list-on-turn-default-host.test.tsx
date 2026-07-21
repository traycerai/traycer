import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  defaultHostId: null as string | null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mocks.defaultHostId,
}));

const delegate = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: (
    harnessId: GuiHarnessId | null,
    hostId: string | null,
  ): void => {
    delegate.spy(harnessId, hostId);
  },
}));

import { useRefreshProvidersListOnTurnDefaultHost } from "@/hooks/providers/use-refresh-providers-list-on-turn-default-host";

function setup(harnessId: GuiHarnessId | null) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useRefreshProvidersListOnTurnDefaultHost(harnessId), {
    wrapper,
  });
}

describe("useRefreshProvidersListOnTurnDefaultHost", () => {
  beforeEach(() => {
    mocks.defaultHostId = null;
    delegate.spy.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it("delegates to useRefreshProvidersListOnTurn with the reactive default host id", () => {
    mocks.defaultHostId = "host-default";
    setup("claude");
    expect(delegate.spy).toHaveBeenCalledWith("claude", "host-default");
  });

  it("passes a null default host id through untouched", () => {
    setup("claude");
    expect(delegate.spy).toHaveBeenCalledWith("claude", null);
  });

  it("passes a null harnessId through untouched", () => {
    mocks.defaultHostId = "host-default";
    setup(null);
    expect(delegate.spy).toHaveBeenCalledWith(null, "host-default");
  });
});
