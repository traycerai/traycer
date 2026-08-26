import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host";
import type { WorktreeChangedScope } from "@traycer/protocol/host/worktree-changed-stream";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostConnectionRefCountForTest,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { useWorktreeListing } from "@/components/settings/panels/worktrees-listing-query";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  clearEpicCreateSeedPending,
  markEpicCreateSeedPending,
} from "@/lib/worktree/pending-epic-create-seeds";
import { WorktreeChangedStreamMount } from "@/providers/worktree-changed-stream-mount";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearEpicCreateSeedPending("epic-1");
});

function entry(branch: string): WorktreeHostEntryV16 {
  return {
    worktreePath: "/wt/app",
    branch,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: 1,
    presence: "present",
    gitUnreadable: false,
  };
}

it("refetches a changed worktree event into the active canonical cache entry without forcing", async () => {
  const requests: boolean[] = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "worktree.listAllForHost": (params) => {
          requests.push(params.forceRefresh);
          return {
            worktrees: [entry(requests.length === 1 ? "stale" : "fresh")],
            nextCursor: null,
          };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const queryClient = createAppQueryClient();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useWorktreeListing(client, true), {
    wrapper: Wrapper,
  });

  await waitFor(() => {
    expect(result.current.worktrees[0]?.branch).toBe("stale");
  });
  const scope = hostQueryKeys.methodScope(
    mockLocalHostEntry.hostId,
    "worktree.listAllForHost",
  );
  expect(queryClient.getQueryCache().findAll({ queryKey: scope })).toHaveLength(
    1,
  );

  act(() => {
    invalidateWorktreeChangedCaches(queryClient, mockLocalHostEntry.hostId, {
      root: false,
      worktreePaths: new Set(["/wt/app"]),
    });
  });

  await waitFor(() => {
    expect(result.current.worktrees[0]?.branch).toBe("fresh");
  });
  expect(requests).toEqual([false, false]);
  expect(queryClient.getQueryCache().findAll({ queryKey: scope })).toHaveLength(
    1,
  );
});

function seedOverlay(
  queryClient: QueryClient,
  path: string,
): readonly unknown[] {
  const key = hostQueryKeys.method(
    mockLocalHostEntry.hostId,
    "worktree.listAllForHost",
    {
      includeActivity: true,
      activityPaths: [path],
      cursor: null,
      limit: null,
      forceRefresh: false,
    },
  );
  queryClient.setQueryData(key, { worktrees: [], nextCursor: null });
  return key;
}

// A `worktreePath` event names exactly one row. Invalidating every on-screen
// row's overlay would turn one commit into one refetch PER ROW - the request
// storm this stream exists to remove.
it("invalidates only the named path's enrichment overlay on a worktreePath event", () => {
  const queryClient = createAppQueryClient();
  const named = seedOverlay(queryClient, "/wt/app");
  const other = seedOverlay(queryClient, "/wt/other");

  invalidateWorktreeChangedCaches(queryClient, mockLocalHostEntry.hostId, {
    root: false,
    worktreePaths: new Set(["/wt/app"]),
  });

  expect(queryClient.getQueryState(named)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
});

// A `root` event says nothing about WHICH worktrees under it moved, so every
// overlay has to re-probe.
it("invalidates every enrichment overlay on a root event", () => {
  const queryClient = createAppQueryClient();
  const named = seedOverlay(queryClient, "/wt/app");
  const other = seedOverlay(queryClient, "/wt/other");

  invalidateWorktreeChangedCaches(queryClient, mockLocalHostEntry.hostId, {
    root: true,
    worktreePaths: new Set(),
  });

  expect(queryClient.getQueryState(named)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
});

// The epic-scoped binding listing feeds the git-diff / file-tree workspace
// pickers. It is binding-backed, not path-backed - a changed worktree can flip
// any epic's rows - so it invalidates at EVERY scope; without it a worktree
// finishing setup (or a cold row re-deriving as a git repo) never reached the
// pickers until a remount refetch.
it("invalidates the epic-scoped binding listing at both scopes", () => {
  const scopes = [
    { root: true, worktreePaths: new Set<string>() },
    { root: false, worktreePaths: new Set(["/wt/app"]) },
  ];
  for (const scope of scopes) {
    const queryClient = createAppQueryClient();
    const key = hostQueryKeys.method(
      mockLocalHostEntry.hostId,
      "worktree.listBindingsForEpic",
      { epicId: "epic-1" },
    );
    queryClient.setQueryData(key, { rows: [] });

    invalidateWorktreeChangedCaches(
      queryClient,
      mockLocalHostEntry.hostId,
      scope,
    );

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  }
});

// A mid-create epic's optimistic binding seed is authoritative until the
// create settles: an active burst refetch could return pre-binding
// `{ rows: [] }` and clobber it. The guard marks the query invalidated
// without refetching, then normal refetching resumes once the pending mark
// clears.
it("marks but does not refetch a mid-create epic's binding listing until the create settles", async () => {
  let requests = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "worktree.listBindingsForEpic": () => {
          requests += 1;
          return { rows: [], folderlessCwd: "/tmp/epic-1" };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const queryClient = createAppQueryClient();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useWorktreeListBindingsForEpicForClient({
        client,
        epicId: "epic-1",
        enabled: true,
      }),
    { wrapper: Wrapper },
  );
  await waitFor(() => {
    expect(result.current.isSuccess).toBe(true);
  });
  expect(requests).toBe(1);
  const key = hostQueryKeys.method(
    mockLocalHostEntry.hostId,
    "worktree.listBindingsForEpic",
    { epicId: "epic-1" },
  );

  markEpicCreateSeedPending("epic-1");
  act(() => {
    invalidateWorktreeChangedCaches(queryClient, mockLocalHostEntry.hostId, {
      root: true,
      worktreePaths: new Set(),
    });
  });
  // Marked invalidated, but no refetch was started for the pending epic.
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(key)?.fetchStatus).toBe("idle");
  expect(requests).toBe(1);

  clearEpicCreateSeedPending("epic-1");
  act(() => {
    invalidateWorktreeChangedCaches(queryClient, mockLocalHostEntry.hostId, {
      root: true,
      worktreePaths: new Set(),
    });
  });
  await waitFor(() => {
    expect(requests).toBe(2);
  });
});

/**
 * `<WorktreeChangedStreamMount />` itself - the reopen lane.
 *
 * Everything above this point exercises `invalidateWorktreeChangedCaches` and
 * the query hooks it feeds; the mount that actually opens the
 * `worktree.changed` subscription and wires its connection status is stubbed
 * at the class boundary here, mirroring
 * `chat-records-stream-mount.test.tsx`'s own reopen-lane suite (the sibling
 * mount that shares this exact mechanism).
 *
 * A terminal close (e.g. the transport's bounded UNAUTHORIZED give-up) used
 * to leave this mount's subscription dead until reload - worktree
 * push-invalidation stopped firing with no error and no visible state. It now
 * opens a reopen lane on the host's shared reconnect engine instead.
 */
interface OpenedWorktreeStream {
  readonly emitChanged: (scope: WorktreeChangedScope) => void;
  readonly emitStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

interface WorktreeMountStreamState {
  readonly opened: Array<OpenedWorktreeStream>;
  closes: number;
  support: StreamMethodSupport | null;
  hostId: string | null;
  hasClient: boolean;
}

const worktreeMountStreamState = vi.hoisted((): WorktreeMountStreamState => ({
  opened: [],
  closes: 0,
  support: "supported",
  hostId: "host-A",
  hasClient: true,
}));

/**
 * ONE stable client object across renders, same reasoning as
 * `chat-records-stream-mount.test.tsx`'s `stubWsStreamClient`: the mount keys
 * its effect on the client's identity, and a mock that minted a fresh object
 * per render would re-run the effect for the wrong reason.
 */
const stubWorktreeWsStreamClient = vi.hoisted((): { readonly stub: true } => ({
  stub: true,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/worktree-changed-stream-client",
  () => ({
    WorktreeChangedStreamClient: class {
      constructor(options: {
        readonly callbacks: {
          readonly onChanged: (scope: WorktreeChangedScope) => void;
          readonly onConnectionStatus: (
            status: StreamConnectionStatus,
            reason: StreamCloseReason | null,
          ) => void;
        };
      }) {
        worktreeMountStreamState.opened.push({
          emitChanged: options.callbacks.onChanged,
          emitStatus: options.callbacks.onConnectionStatus,
        });
      }
      close(): void {
        worktreeMountStreamState.closes += 1;
      }
    },
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () =>
    worktreeMountStreamState.hasClient ? stubWorktreeWsStreamClient : null,
  useStreamMethodSupport: () => worktreeMountStreamState.support,
  // The mount now reads its host id off the SAME `StreamRuntimeBinding` as
  // the client (`useStreamHostId`), not the separately-updating
  // `useAddressableHostId` - so the stub lives on this mock, not a second one.
  useStreamHostId: () => worktreeMountStreamState.hostId,
}));

function emitWorktreeMountStatus(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): void {
  const stream = worktreeMountStreamState.opened.at(-1);
  if (stream === undefined) throw new Error("no stream opened");
  act(() => {
    stream.emitStatus(status, reason);
  });
}

function worktreeMountFatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function renderWorktreeChangedStreamMount(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <WorktreeChangedStreamMount />
    </QueryClientProvider>,
  );
}

describe("<WorktreeChangedStreamMount /> reopen lane", () => {
  afterEach(() => {
    cleanup();
    resetHostConnectionRegistryForTest();
    worktreeMountStreamState.opened.length = 0;
    worktreeMountStreamState.closes = 0;
    worktreeMountStreamState.support = "supported";
    worktreeMountStreamState.hostId = "host-A";
    worktreeMountStreamState.hasClient = true;
  });

  it("opens exactly one host-scoped subscription and closes it on unmount", () => {
    const queryClient = createAppQueryClient();
    const { unmount } = renderWorktreeChangedStreamMount(queryClient);
    expect(worktreeMountStreamState.opened).toHaveLength(1);
    unmount();
    expect(worktreeMountStreamState.closes).toBe(1);
  });

  it("rebuilds the client after a reopenable terminal close, once the backoff elapses", () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      renderWorktreeChangedStreamMount(queryClient);
      expect(worktreeMountStreamState.opened).toHaveLength(1);

      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("UNAUTHORIZED"),
      );
      // Not yet - the reopen lane waits out its backoff first.
      expect(worktreeMountStreamState.opened).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(2);
      expect(worktreeMountStreamState.closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen after a non-reopenable close (CLIENT_CLOSED)", () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      renderWorktreeChangedStreamMount(queryClient);
      expect(worktreeMountStreamState.opened).toHaveLength(1);

      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("CLIENT_CLOSED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 10);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the reopen lane and releases the host connection on unmount", () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      const { unmount } = renderWorktreeChangedStreamMount(queryClient);
      expect(worktreeMountStreamState.opened).toHaveLength(1);
      expect(hostConnectionRefCountForTest("host-A")).toBe(1);

      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("UNAUTHORIZED"),
      );
      unmount();
      expect(hostConnectionRefCountForTest("host-A")).toBe(0);

      // The reopen timer was armed but not yet fired; disposal on unmount
      // must cancel it rather than let it construct a client for an
      // unmounted mount.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 10);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the reopen lane's backoff after a close that followed a healthy (>=30s open) session", () => {
    // HEALTHY_SESSION_RESET_MS is module-local (30_000) - not exported, so
    // pinned here by literal value.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const queryClient = createAppQueryClient();
      renderWorktreeChangedStreamMount(queryClient);
      expect(worktreeMountStreamState.opened).toHaveLength(1);

      // First close never reported "open" at all, so it is not healthy - the
      // lane's backoff is untouched (still its initial 5s) for THIS
      // schedule, then doubles to 10s for the next one.
      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(2);

      // Second client: report "open", let it dwell >= 30s, then close.
      emitWorktreeMountStatus("open", null);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("UNAUTHORIZED"),
      );

      // Without the healthy-dwell reset this close would inherit the doubled
      // 10s backoff from the first close - advancing only the INITIAL 5s
      // here is what proves the reset happened.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the reopen lane's backoff after a quick (<30s) close", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const queryClient = createAppQueryClient();
      renderWorktreeChangedStreamMount(queryClient);
      expect(worktreeMountStreamState.opened).toHaveLength(1);

      // First close (also not healthy): schedules at the initial 5s, then
      // doubles to 10s for the next one.
      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(2);

      // Second client: opens, but closes almost immediately - well under the
      // 30s healthy dwell - so the backoff must NOT reset.
      emitWorktreeMountStatus("open", null);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      emitWorktreeMountStatus(
        "closed",
        worktreeMountFatalClose("UNAUTHORIZED"),
      );

      // The doubled 10s backoff is still in force: the initial 5s alone is
      // not enough to reopen.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(2);

      // The remaining 5s completes the 10s window.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(worktreeMountStreamState.opened).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
