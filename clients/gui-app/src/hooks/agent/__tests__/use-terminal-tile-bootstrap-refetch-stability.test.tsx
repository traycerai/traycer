import "../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseTerminalSessionHandleArgs } from "@/lib/registries/terminal-session-registry";

// A live session handle must survive `terminal.list` REFETCHES. The handle
// gate used to derive from `hostHasSession`, which degrades to `null`
// whenever the list query is in flight - so any invalidation of
// `terminal.list` released the handle (closing the PTY stream), reacquired
// it when the refetch settled, and the fresh subscription's snapshot pushed
// metadata that invalidated the list again: an endless subscribe/release
// loop that left reattached terminals blank. The handle may only be
// released on a SETTLED list that shows the session gone or exited.

let mockList: {
  data: { sessions: ReadonlyArray<Record<string, unknown>> } | undefined;
  isFetching: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
};
let mockCreate: {
  isError: boolean;
  isIdle: boolean;
  isSuccess: boolean;
  error: Error | null;
  reset: () => void;
  mutate: Mock;
};
let handleCalls: UseTerminalSessionHandleArgs[];

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({
    hostId: "host-1",
    label: "Host 1",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    status: "available",
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => "host-1",
    getRequestContextUserId: () => "user-1",
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => mockList,
}));

vi.mock("@/hooks/terminal/use-terminal-create-mutation", () => ({
  useTerminalCreate: () => mockCreate,
}));

// Capture the args the bootstrap feeds the session handle so the tests can
// assert on the `enabled` / `reattachMode` the registry would act on.
vi.mock("@/lib/registries/terminal-session-registry", () => ({
  useTerminalSessionHandle: (args: UseTerminalSessionHandleArgs) => {
    handleCalls.push(args);
    return null;
  },
}));

import { useTerminalTileBootstrap } from "../use-terminal-tile-bootstrap";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function runBootstrap() {
  return renderHook(
    () =>
      useTerminalTileBootstrap({
        hostId: "host-1",
        sessionId: "term-1",
        instanceId: "inst-1",
        sessionKind: "terminal",
        preparePayload: () =>
          Promise.resolve({
            tuiHarnessId: null,
            cwd: "/work/repo",
            shellCommand: null,
            shellArgs: null,
            worktreeBusyPaths: [],
          }),
      }),
    { wrapper },
  );
}

function lastHandleArgs(): UseTerminalSessionHandleArgs {
  const last = handleCalls.at(-1);
  if (last === undefined)
    throw new Error("useTerminalSessionHandle not called");
  return last;
}

describe("useTerminalTileBootstrap handle gate across list refetches", () => {
  beforeEach(() => {
    handleCalls = [];
    mockCreate = {
      isError: false,
      isIdle: true,
      isSuccess: false,
      error: null,
      reset: () => undefined,
      mutate: vi.fn(),
    };
    mockList = {
      data: {
        sessions: [
          { sessionId: "term-1", sessionKind: "terminal", status: "running" },
        ],
      },
      isFetching: false,
      isPending: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve({}),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the handle enabled (live) while terminal.list is refetching", async () => {
    const { rerender } = runBootstrap();
    await waitFor(() => {
      expect(lastHandleArgs().enabled).toBe(true);
    });
    expect(lastHandleArgs().reattachMode).toBe("live");

    // Background refetch in flight: previous data is retained. The handle
    // must stay enabled - releasing it here is the reattach-loop regression.
    mockList.isFetching = true;
    rerender();

    expect(lastHandleArgs().enabled).toBe(true);
    expect(lastHandleArgs().reattachMode).toBe("live");
    // And the in-flight window must not trigger a spurious create either.
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it("releases the handle when a SETTLED list shows the session exited", async () => {
    const { rerender } = runBootstrap();
    await waitFor(() => {
      expect(lastHandleArgs().enabled).toBe(true);
    });

    mockList.data = {
      sessions: [
        { sessionId: "term-1", sessionKind: "terminal", status: "exited" },
      ],
    };
    mockList.isFetching = false;
    rerender();

    expect(lastHandleArgs().enabled).toBe(false);
  });

  it("keeps the handle disabled until the first list resolves", () => {
    mockList.data = undefined;
    mockList.isPending = true;

    runBootstrap();

    expect(lastHandleArgs().enabled).toBe(false);
  });
});
