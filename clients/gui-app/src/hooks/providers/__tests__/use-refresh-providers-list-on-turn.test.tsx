import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ReactNode } from "react";

// Capture the turn-completion subscriber so tests can fire synthetic completions.
const sub = vi.hoisted(() => ({
  handler: null as null | ((completion: { harnessId: GuiHarnessId }) => void),
}));
vi.mock("@/lib/chats/chat-turn-completions", () => ({
  subscribeChatTurnCompletions: (
    cb: (completion: { harnessId: GuiHarnessId }) => void,
  ) => {
    sub.handler = cb;
    return () => {
      sub.handler = null;
    };
  },
}));

import { useRefreshProvidersListOnTurn } from "@/hooks/providers/use-refresh-providers-list-on-turn";

function fireTurn(harnessId: GuiHarnessId): void {
  act(() => {
    sub.handler?.({ harnessId });
  });
}

function setup(harnessId: GuiHarnessId | null, hostId: string | null) {
  const queryClient = new QueryClient();
  const invalidateSpy = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => useRefreshProvidersListOnTurn(harnessId, hostId), {
    wrapper,
  });
  return { invalidateSpy };
}

describe("useRefreshProvidersListOnTurn", () => {
  beforeEach(() => {
    sub.handler = null;
  });
  afterEach(() => {
    cleanup();
  });

  it("invalidates the tab-scoped providers.list query when a matching turn completes", () => {
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("claude");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["host", "host-a", "providers.list", {}],
    });
  });

  it("ignores completions from a different harness", () => {
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("codex");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("throttles bursts of matching completions to the outer cooldown", () => {
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("claude");
    fireTurn("claude");
    fireTurn("claude");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops while harnessId is null", () => {
    const { invalidateSpy } = setup(null, "host-a");
    expect(sub.handler).toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
