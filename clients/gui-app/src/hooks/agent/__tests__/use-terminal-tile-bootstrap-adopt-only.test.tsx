import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// `adoptOnly` tiles (a provider sign-in terminal attaching to a host-created
// PTY) never dispatch `terminal.create`, but - unlike the old `enabled: false`
// spelling this replaced - the measure-grid wait must still ARM for them. A
// sign-in tile's measurement probe can go unreported forever (a stalled xterm
// chunk, a zero-sized container): without the bounded wait firing, `gridReady`
// never flips and the session handle never acquires, stranding the tile on
// "Starting terminal session…" with no timeout and no error. These cases
// cover that gate directly on the hook - see
// `terminal-tile-provider-login-no-create.test.tsx` for the full-tile version,
// which mocks the probe to report SYNCHRONOUSLY and so cannot observe this.

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
let mockHandle: Record<string, unknown> | null;
const useTerminalSessionHandleSpy = vi.fn(
  (args: { readonly enabled: boolean }) => (args.enabled ? mockHandle : null),
);

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

vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/registries/terminal-session-registry")
    >()),
    useTerminalSessionHandle: (args: { readonly enabled: boolean }) =>
      useTerminalSessionHandleSpy(args),
  }),
);

import {
  MEASURE_GRID_TIMEOUT_MS,
  useTerminalTileBootstrap,
} from "../use-terminal-tile-bootstrap";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function runBootstrap(props: {
  readonly enabled?: boolean;
  readonly adoptOnly?: boolean;
}) {
  return renderHook(
    () =>
      useTerminalTileBootstrap({
        hostId: "host-1",
        scope: { kind: "epic", epicId: "epic-1" },
        sessionId: "term-signin",
        instanceId: "inst-signin",
        sessionKind: "terminal",
        enabled: props.enabled,
        adoptOnly: props.adoptOnly,
        preparePayload: () =>
          Promise.resolve({
            tuiHarnessId: null,
            cwd: "~",
            shellCommand: null,
            shellArgs: null,
            worktreeBusyPaths: [],
          }),
      }),
    { wrapper },
  );
}

describe("useTerminalTileBootstrap adoptOnly grid-timeout arming", () => {
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
      data: {
        sessions: [
          {
            sessionId: "term-signin",
            sessionKind: "terminal",
            status: "running",
          },
        ],
      },
      isFetching: false,
      isPending: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve({}),
    };
    mockHandle = { sessionId: "term-signin" };
    useTerminalSessionHandleSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("acquires the session handle after the measure timeout when the probe never reports (host already lists the session running)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = runBootstrap({ adoptOnly: true });

      // No `reportMeasuredGrid` call at all - the probe never reports.
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.handle).toBeNull();

      act(() => {
        vi.advanceTimersByTime(MEASURE_GRID_TIMEOUT_MS);
      });

      await waitFor(() => {
        expect(result.current.handle).not.toBeNull();
      });
      expect(mockCreate.mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never dispatches terminal.create for an adopt-only tile, even once the grid times out and the host has not (yet) listed the session", async () => {
    // Defense-in-depth case: the list momentarily disagrees with reality (a
    // race, or the session just not caught up yet) while adoptOnly is set.
    // Without the dedicated `adoptOnly` gate in the create effect, a timed-out
    // grid would be enough to dispatch `terminal.create` here and spawn a
    // bare, provider-less shell in place of the host's sign-in PTY.
    mockList.data = { sessions: [] };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      runBootstrap({ adoptOnly: true });

      act(() => {
        vi.advanceTimersByTime(MEASURE_GRID_TIMEOUT_MS);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockCreate.mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm the measure timeout for a plain enabled:false tile (TUI-style gate, not adoptOnly)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = runBootstrap({ enabled: false });

      act(() => {
        vi.advanceTimersByTime(MEASURE_GRID_TIMEOUT_MS + 500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      // `enabled: false` (not adoptOnly) must leave the wait disarmed - the
      // handle never acquires even long past the timeout ceiling.
      expect(result.current.handle).toBeNull();
      expect(mockCreate.mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
