import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import {
  markWorktreePullRequestTouchedForTests,
  resetWorktreePullRequestTouchesForTests,
  useWorktreeEnrichmentForClient,
  WORKTREE_PR_TOUCH_INTERVAL_MS,
} from "@/hooks/worktree/use-worktree-enrichment-query";
import { useWorktreeHostIndexForClient } from "@/hooks/worktree/use-task-worktree-metadata-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  markWorktreeChangedStreamOpen,
  resetWorktreeChangedCoverageForTests,
} from "@/lib/worktree/worktree-changed-coverage";

/**
 * Every worktree surface outside Settings reads ONE host-wide paged listing;
 * selection-mode reads are spent only on rows the listing reports unresolved
 * and on a PR-freshness touch at most every five minutes per host. A
 * navigation or remount costs nothing while the host's `worktree.changed`
 * stream is open, and a frame costs one listing read.
 */

const HOST_ID = mockLocalHostEntry.hostId;

function row(
  worktreePath: string,
  resolvedAt: number | null,
  branch: string,
): WorktreeHostEntryV16 {
  return {
    worktreePath,
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
    resolvedAt,
    presence: "present",
    gitUnreadable: false,
  };
}

interface Host {
  /** What the paged listing answers. */
  listing: WorktreeHostEntryV16[];
  /** What a selection read answers for a path (defaults to the listing's row). */
  readonly selection: Map<string, WorktreeHostEntryV16>;
}

interface Fixture {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly host: Host;
  readonly pagedCalls: () => number;
  readonly selectionCalls: string[][];
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createFixture(listing: WorktreeHostEntryV16[]): Fixture {
  const queryClient = createAppQueryClient();
  const host: Host = { listing, selection: new Map() };
  let paged = 0;
  const selectionCalls: string[][] = [];
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
          if (params.activityPaths === null) {
            paged += 1;
            return Promise.resolve({
              worktrees: [...host.listing],
              nextCursor: null,
            });
          }
          selectionCalls.push([...params.activityPaths]);
          return Promise.resolve({
            worktrees: params.activityPaths.flatMap((path) => {
              const answered =
                host.selection.get(path) ??
                host.listing.find((entry) => entry.worktreePath === path);
              return answered === undefined ? [] : [answered];
            }),
            nextCursor: null,
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    queryClient,
    client,
    host,
    pagedCalls: () => paged,
    selectionCalls,
    Wrapper,
  };
}

async function settle(): Promise<void> {
  // Past the batcher's coalescing window, so a queued selection read is sent.
  await new Promise((resolve) => setTimeout(resolve, 60));
}

const RESOLVED = [row("/wt/a", 10, "a"), row("/wt/b", 10, "b")];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetWorktreePullRequestTouchesForTests();
  resetWorktreeChangedCoverageForTests();
});

describe("worktree metadata from one paged read per host", () => {
  it("serves the index and the enriched rows of resolved worktrees from one paged read", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    const paths = ["/wt/a", "/wt/b"];

    const { result } = renderHook(
      () => ({
        index: useWorktreeHostIndexForClient(fixture.client, true),
        rows: useWorktreeEnrichmentForClient(fixture.client, paths, true),
      }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.rows.worktrees).toHaveLength(2));
    await settle();
    expect(result.current.index.worktrees).toHaveLength(2);
    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("costs nothing on a remount while the host's stream is open, however old the read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    const paths = ["/wt/a"];
    const mount = () =>
      renderHook(
        () => useWorktreeEnrichmentForClient(fixture.client, paths, true),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + 3 * 60_000);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees).toHaveLength(1),
    );
    await settle();

    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("re-reads the listing on a remount after a minute when no stream watches the host", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture(RESOLVED);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    const paths = ["/wt/a"];
    const mount = () =>
      renderHook(
        () => useWorktreeEnrichmentForClient(fixture.client, paths, true),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + 2 * 60_000);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    mount();
    await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
  });

  it("reads only the rows the listing reports unresolved, and shows what that read derived", async () => {
    const fixture = createFixture([
      row("/wt/a", 10, "a"),
      row("/wt/cold", null, "(unresolved)"),
    ]);
    fixture.host.selection.set("/wt/cold", row("/wt/cold", 20, "derived"));
    markWorktreeChangedStreamOpen(HOST_ID);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    const paths = ["/wt/a", "/wt/cold"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() =>
      expect(result.current.worktrees.map((entry) => entry.branch)).toEqual([
        "a",
        "derived",
      ]),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/cold"]]);
  });

  it("touches every requested row once when the PR touch is due, then not again within the interval", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/b"];
    const mount = () =>
      renderHook(
        () => useWorktreeEnrichmentForClient(fixture.client, paths, true),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(fixture.selectionCalls).toHaveLength(1));
    expect([...fixture.selectionCalls[0]].sort()).toEqual(["/wt/a", "/wt/b"]);
    first.unmount();

    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees).toHaveLength(2),
    );
    await settle();
    expect(fixture.selectionCalls).toHaveLength(1);
    expect(WORKTREE_PR_TOUCH_INTERVAL_MS).toBe(5 * 60_000);
  });

  it("shows whichever copy resolved last: a newer listing over an older selection answer", async () => {
    const fixture = createFixture([row("/wt/a", 10, "old")]);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true),
      { wrapper: fixture.Wrapper },
    );
    // The first mount's touch caches a selection answer at resolvedAt 10.
    await waitFor(() => expect(fixture.selectionCalls).toHaveLength(1));
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("old"),
    );

    // The host re-derived the row and announced it: one listing read.
    fixture.host.listing = [row("/wt/a", 30, "new")];
    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set(["/wt/a"]),
      });
    });

    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("new"),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(2);
    expect(fixture.selectionCalls).toHaveLength(1);
  });

  it("answers a root catch-up frame with one listing read and no per-row reads", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    markWorktreePullRequestTouchedForTests(HOST_ID, Date.now());
    const paths = ["/wt/a", "/wt/b"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.worktrees).toHaveLength(2));

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: true,
        worktreePaths: new Set(),
      });
    });
    await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
    await settle();
    expect(fixture.selectionCalls).toEqual([]);
  });
});
