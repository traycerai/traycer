import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRefreshOverviewStatusOnSessionActivity } from "@/components/settings/panels/host-overview-rpc";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  disposeAllChatSessions,
  getChatSessionRegistry,
} from "@/lib/registries/chat-session-registry";
import {
  disposeAllTerminalSessions,
  getTerminalSessionRegistry,
} from "@/lib/registries/terminal-session-registry";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";

const HOST_A = "host-a";
const HOST_B = "host-b";
const CHAT_SCOPE = "test-scope:user:host:transport";

afterEach(() => {
  cleanup();
  disposeAllTerminalSessions();
  disposeAllChatSessions();
});

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function wrapperFor(
  queryClient: QueryClient,
  strictMode: boolean,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    const inner = (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    if (!strictMode) return inner;
    return <StrictMode>{inner}</StrictMode>;
  };
}

function mountRefresh(input: {
  readonly queryClient: QueryClient;
  readonly hostId: string;
  readonly strictMode: boolean;
}): void {
  renderHook(
    () =>
      useRefreshOverviewStatusOnSessionActivity({
        hostId: input.hostId,
        enabled: true,
      }),
    { wrapper: wrapperFor(input.queryClient, input.strictMode) },
  );
}

function hostStatusKey(hostId: string) {
  return hostQueryKeys.methodScope(hostId, "host.status");
}

function createTerminalHandle(sessionId: string): TerminalSessionStoreHandle {
  return createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
    sessionId,
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: "terminal-agent",
    streamClientFactory: () => ({
      sendAction: () => undefined,
      close: () => undefined,
    }),
  });
}

function createChatHandle(
  epicId: string,
  chatId: string,
): ChatSessionStoreHandle {
  return createChatSessionStore({
    hostId: "store-host",
    epicId,
    chatId,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      close: () => undefined,
    }),
  });
}

describe("useRefreshOverviewStatusOnSessionActivity", () => {
  it("does not invalidate host.status for an other-host terminal membership change", () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mountRefresh({ queryClient, hostId: HOST_A, strictMode: false });

    act(() => {
      getTerminalSessionRegistry().acquire(
        "term-b",
        () => createTerminalHandle("terminal-b"),
        HOST_B,
      );
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates host.status when this host's terminal membership changes", () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mountRefresh({ queryClient, hostId: HOST_A, strictMode: false });

    act(() => {
      getTerminalSessionRegistry().acquire(
        "term-a",
        () => createTerminalHandle("terminal-a"),
        HOST_A,
      );
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: hostStatusKey(HOST_A),
    });
  });

  it("does not invalidate host.status for an other-host chat membership change", () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mountRefresh({ queryClient, hostId: HOST_A, strictMode: false });

    act(() => {
      getChatSessionRegistry().acquire(
        {
          epicId: "epic-1",
          chatId: "chat-b",
          hostId: HOST_B,
          scopeKey: CHAT_SCOPE,
        },
        () => createChatHandle("epic-1", "chat-b"),
      );
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates host.status when this host's chat membership changes", () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mountRefresh({ queryClient, hostId: HOST_A, strictMode: false });

    act(() => {
      getChatSessionRegistry().acquire(
        {
          epicId: "epic-1",
          chatId: "chat-a",
          hostId: HOST_A,
          scopeKey: CHAT_SCOPE,
        },
        () => createChatHandle("epic-1", "chat-a"),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: hostStatusKey(HOST_A),
    });
  });

  it("does not invalidate on a StrictMode remount with unchanged membership", () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    act(() => {
      getTerminalSessionRegistry().acquire(
        "term-a",
        () => createTerminalHandle("terminal-a"),
        HOST_A,
      );
    });

    mountRefresh({ queryClient, hostId: HOST_A, strictMode: true });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
