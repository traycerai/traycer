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

// A terminal tile must create its PTY at most once and must NOT respawn a
// session the host reports as `exited` (the user ran `exit` / killed it
// from the sidebar). It SHOULD still create when the session is simply
// absent (fresh tile, or host-restart resilience). These cases cover the
// `hostSessionExited` gate in useTerminalTileBootstrap.

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

// The session handle resolution is irrelevant to the create gate; stub it.
vi.mock("@/lib/registries/terminal-session-registry", () => ({
  useTerminalSessionHandle: () => null,
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

function runBootstrap(sessionKind: "terminal" | "terminal-agent") {
  return renderHook(
    () =>
      useTerminalTileBootstrap({
        hostId: "host-1",
        sessionId: "term-1",
        instanceId: "inst-1",
        sessionKind,
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

describe("useTerminalTileBootstrap create gate", () => {
  beforeEach(() => {
    mockCreate = {
      isError: false,
      isIdle: true,
      isSuccess: false,
      error: null,
      reset: () => undefined,
      mutate: vi.fn(),
    };
    mockList = {
      data: { sessions: [] },
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

  it("does NOT respawn a session the host reports as exited", async () => {
    // Reattach-then-exit: the session is present but exited (host grace
    // window). `createIsIdle` is true (this tile never created it), so
    // without the gate the bootstrap would re-dispatch terminal.create.
    mockList.data = {
      sessions: [
        { sessionId: "term-1", sessionKind: "terminal", status: "exited" },
      ],
    };

    runBootstrap("terminal");

    // Give effects a couple of ticks to settle; assert no create fired.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it("creates a session that is absent from the host list", async () => {
    // Fresh tile (or host-restart resilience): no host record at all.
    mockList.data = { sessions: [] };

    runBootstrap("terminal");

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalledTimes(1);
    });
    const [request] = mockCreate.mutate.mock.calls[0] as [
      { readonly desiredSessionId: string },
    ];
    expect(request.desiredSessionId).toBe("term-1");
  });

  it("DOES re-create an exited terminal-agent (stable id, reopen restarts)", async () => {
    // The exit gate is plain-terminal-only. A terminal-agent keys its PTY on
    // the stable agent-record id, so reopening within the host grace window
    // must restart it rather than be stranded by a lingering `exited` entry.
    mockList.data = {
      sessions: [
        {
          sessionId: "term-1",
          sessionKind: "terminal-agent",
          status: "exited",
        },
      ],
    };

    runBootstrap("terminal-agent");

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalledTimes(1);
    });
  });
});
