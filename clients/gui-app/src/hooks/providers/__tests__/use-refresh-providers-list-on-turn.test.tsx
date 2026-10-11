import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ReactNode } from "react";

interface TestCompletion {
  readonly harnessId: GuiHarnessId;
  readonly hostId: string | null;
}

// Capture the turn-completion subscriber so tests can fire synthetic completions.
const sub = vi.hoisted(() => ({
  handler: null as null | ((completion: TestCompletion) => void),
}));
vi.mock("@/lib/chats/chat-turn-completions", () => ({
  subscribeChatTurnCompletions: (cb: (completion: TestCompletion) => void) => {
    sub.handler = cb;
    return () => {
      sub.handler = null;
    };
  },
}));

import { useRefreshProvidersListOnTurn } from "@/hooks/providers/use-refresh-providers-list-on-turn";

function fireTurn(harnessId: GuiHarnessId, hostId: string | null): void {
  act(() => {
    sub.handler?.({ harnessId, hostId });
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

  it("invalidates the tab-scoped classic providers.list query when a matching turn completes", () => {
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("claude", "host-a");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    // The exact CLASSIC key, not the `providers.list` method scope: the same
    // method also carries the native (MCP/plugins/skills) queries, and a turn
    // completion says nothing about those. A scope-wide (3-element prefix)
    // invalidation would refetch every native list on every turn.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["host", "host-a", "providers.list", { native: null }],
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ["host", "host-a", "providers.list"],
    });
  });

  it("ignores completions from a different harness", () => {
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("codex", "host-a");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores completions from a different host, even on a matching harness", () => {
    // A background chat on another host completing a `claude` turn must not
    // refresh THIS tab's providers.list - that would be cross-host bleed.
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("claude", "host-b");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("throttles bursts of matching completions to the outer cooldown", () => {
    const { invalidateSpy } = setup("claude", "host-a");
    fireTurn("claude", "host-a");
    fireTurn("claude", "host-a");
    fireTurn("claude", "host-a");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops while harnessId is null", () => {
    const { invalidateSpy } = setup(null, "host-a");
    expect(sub.handler).toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("no-ops while hostId is null", () => {
    const { invalidateSpy } = setup("claude", null);
    expect(sub.handler).toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
