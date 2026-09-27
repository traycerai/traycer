import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import { useWorktreeEnrichmentForClient } from "@/hooks/worktree/use-worktree-enrichment-query";
import { useWorktreeHostIndexForClient } from "@/hooks/worktree/use-task-worktree-metadata-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  isWorktreeChangedStreamCovered,
  markWorktreeChangedStreamOpen,
  markWorktreeChangedStreamClosed,
  resetWorktreeChangedCoverageForTests,
  WORKTREE_CHANGED_RECOVERY_GRACE_MS,
} from "@/lib/worktree/worktree-changed-coverage";

/**
 * Every worktree surface outside Settings reads ONE host-wide paged listing;
 * selection-mode reads are spent only on rows the listing reports unresolved.
 * A navigation or remount costs nothing while the host's `worktree.changed`
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
    // Resolved fixture rows are settled unless a test opts in to missing
    // activity explicitly. `null` means the listing lacks PR activity facts.
    prState: "none",
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
  resetWorktreeChangedCoverageForTests();
});

describe("worktree metadata from one paged read per host", () => {
  it("serves the index and the enriched rows of resolved worktrees from one paged read", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/b"];

    const { result } = renderHook(
      () => ({
        index: useWorktreeHostIndexForClient(fixture.client, true),
        rows: useWorktreeEnrichmentForClient(
          fixture.client,
          paths,
          true,
          "none",
        ),
      }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.rows.worktrees).toHaveLength(2));
    await settle();
    expect(result.current.index.worktrees).toHaveLength(2);
    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("requests activity for resolved rows in the PR-number History index even under replay coverage", async () => {
    const fixture = createFixture([row("/wt/a", 10, "a")]);
    fixture.host.selection.set("/wt/a", {
      ...row("/wt/a", 20, "a"),
      prState: "open" as const,
      prNumber: 42,
      prUrl: "https://example.test/pull/42",
      branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
    });
    markWorktreeChangedStreamOpen(HOST_ID);

    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          ["/wt/a"],
          true,
          "always",
        ),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.worktrees[0]?.prNumber).toBe(42));
    await settle();

    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    expect(result.current.worktrees[0]?.prState).toBe("open");
  });

  it("reads only missing PR activity for task metadata rows and carries submodule facts", async () => {
    const missingActivity = {
      ...row("/wt/missing", 10, "listed"),
      prState: null,
    };
    const settledActivity = row("/wt/settled", 10, "settled");
    const fixture = createFixture([missingActivity, settledActivity]);
    fixture.host.selection.set("/wt/missing", {
      ...row("/wt/missing", 10, "selection"),
      prState: "open",
      prNumber: 51,
      prUrl: "https://example.test/pull/51",
      submodules: [
        {
          repoIdentifier: { owner: "acme", repo: "shared" },
          branch: "feature/shared",
          prState: "merged",
          prNumber: 52,
          prUrl: "https://example.test/shared/pull/52",
          mergedHeadShaMatches: true,
          mergedIntoDefault: true,
          atPinnedCommit: true,
          unmergedCommitCount: null,
          unmergedCommitSubjects: null,
        },
      ],
    });
    markWorktreeChangedStreamOpen(HOST_ID);

    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          ["/wt/missing", "/wt/settled"],
          true,
          "ifMissing",
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() =>
      expect(result.current.worktrees[0]?.submodules).toHaveLength(1),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/missing"]]);
    expect(result.current.worktrees[0]).toMatchObject({
      branch: "listed",
      prState: "open",
      prNumber: 51,
      submodules: [
        {
          repoIdentifier: { owner: "acme", repo: "shared" },
          prState: "merged",
          prNumber: 52,
        },
      ],
    });
    expect(result.current.worktrees[1]?.prState).toBe("none");
  });

  it("costs nothing on remount with the host stream open and performs no resolved-row enrichment reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a"];
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + 3 * 60_000);
    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees).toHaveLength(1),
    );
    await settle();

    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("re-reads the listing on a remount when no stream watches the host", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture(RESOLVED);
    const paths = ["/wt/a"];
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + 2 * 60_000);
    mount();
    await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
  });

  it("keeps a listing covered through reconnect grace, then returns to the 60-second freshness fallback", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const mount = () =>
      renderHook(() => useWorktreeHostIndexForClient(fixture.client, true), {
        wrapper: fixture.Wrapper,
      });
    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(2));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      markWorktreeChangedStreamClosed(HOST_ID);
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(true);
      expect(fixture.pagedCalls()).toBe(1);
      vi.setSystemTime(Date.now() + WORKTREE_CHANGED_RECOVERY_GRACE_MS);
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(false);
      first.unmount();
      const second = mount();
      await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
      expect(second.result.current.worktrees).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches one shared mounted listing after reconnect grace expires", async () => {
    const fixture = createFixture([row("/wt/a", 10, "before reconnect")]);
    markWorktreeChangedStreamOpen(HOST_ID);
    const indexConsumer = renderHook(
      () => useWorktreeHostIndexForClient(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );
    const rowConsumer = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, ["/wt/a"], true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(indexConsumer.result.current.worktrees[0]?.branch).toBe(
        "before reconnect",
      );
      expect(rowConsumer.result.current.worktrees[0]?.branch).toBe(
        "before reconnect",
      );
    });
    expect(fixture.pagedCalls()).toBe(1);

    vi.useFakeTimers();
    try {
      markWorktreeChangedStreamClosed(HOST_ID);
      fixture.host.listing = [row("/wt/a", 20, "after grace")];
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_CHANGED_RECOVERY_GRACE_MS);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(30);
        await Promise.resolve();
      });
      expect(fixture.pagedCalls()).toBe(2);
      expect(indexConsumer.result.current.worktrees[0]?.branch).toBe(
        "after grace",
      );
      expect(rowConsumer.result.current.worktrees[0]?.branch).toBe(
        "after grace",
      );
      expect(fixture.pagedCalls()).toBe(2);
      expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches a mounted missing-activity path once when replay grace expires", async () => {
    const fixture = createFixture([
      { ...row("/wt/a", 10, "a"), prState: null },
    ]);
    const selectionRow = {
      ...row("/wt/a", 10, "a"),
      prState: "open" as const,
      prNumber: 54,
      prUrl: "https://example.test/pull/54",
    };
    fixture.host.selection.set("/wt/a", selectionRow);
    markWorktreeChangedStreamOpen(HOST_ID);
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(
            fixture.client,
            ["/wt/a"],
            true,
            "ifMissing",
          ),
        { wrapper: fixture.Wrapper },
      );
    const first = mount();
    const second = mount();
    await waitFor(() =>
      expect(first.result.current.worktrees[0]?.prState).toBe("open"),
    );
    await settle();
    expect(second.result.current.worktrees[0]?.prNumber).toBe(54);
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    expect(fixture.pagedCalls()).toBe(1);

    vi.useFakeTimers();
    try {
      markWorktreeChangedStreamClosed(HOST_ID);
      fixture.host.selection.set("/wt/a", {
        ...selectionRow,
        prState: "merged",
        resolvedAt: 20,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_CHANGED_RECOVERY_GRACE_MS);
        await vi.advanceTimersByTimeAsync(1);
        // The path read coalesces in the enrichment batcher's 25ms window.
        await vi.advanceTimersByTimeAsync(30);
        await Promise.resolve();
      });
      vi.useRealTimers();
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(false);
      expect(fixture.pagedCalls()).toBe(2);
      await waitFor(() => expect(fixture.selectionCalls).toHaveLength(2));
      await waitFor(() =>
        expect(first.result.current.worktrees[0]?.prState).toBe("merged"),
      );
      expect(second.result.current.worktrees[0]?.prState).toBe("merged");
      expect(fixture.selectionCalls).toEqual([["/wt/a"], ["/wt/a"]]);
      expect(fixture.pagedCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps touching a resolved row on an unwatched host so an external PR merge appears after stale remount", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const open = {
      ...row("/wt/a", 10, "a"),
      prState: "open" as const,
      prNumber: 41,
      prUrl: "https://example.test/pull/41",
    };
    const fixture = createFixture([open]);
    fixture.host.selection.set("/wt/a", open);
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(
            fixture.client,
            ["/wt/a"],
            true,
            "none",
          ),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() =>
      expect(first.result.current.worktrees[0]?.prState).toBe("open"),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    first.unmount();

    fixture.host.selection.set("/wt/a", {
      ...row("/wt/a", 20, "a"),
      prState: "merged",
      prNumber: 41,
      prUrl: "https://example.test/pull/41",
    });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees[0]?.prState).toBe("merged"),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(2);
    expect(fixture.selectionCalls).toEqual([["/wt/a"], ["/wt/a"]]);
  });

  it("reads only the rows the listing reports unresolved, and shows what that read derived", async () => {
    const fixture = createFixture([
      row("/wt/a", 10, "a"),
      row("/wt/cold", null, "(unresolved)"),
    ]);
    fixture.host.selection.set("/wt/cold", row("/wt/cold", 20, "derived"));
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/cold"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
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

  it("shows whichever copy resolved last: a newer listing over an older selection answer", async () => {
    const fixture = createFixture([row("/wt/a", 10, "old")]);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
      { wrapper: fixture.Wrapper },
    );
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
    expect(fixture.selectionCalls).toHaveLength(0);
  });

  it("prefers a later listing's owners, inUse and scripts when resolvedAt ties the selection answer", async () => {
    const oldSelection = {
      ...row("/wt/a", 10, "selection-answer"),
      prState: "open" as const,
      prNumber: 43,
      prUrl: "https://example.test/pull/43",
      branchStatus: { ahead: 3, behind: 1, mergedIntoDefault: false },
      owners: [
        {
          epicId: "old-epic",
          ownerKind: "chat" as const,
          ownerId: "old-chat",
          updatedAt: 1,
        },
      ],
      inUse: true,
      scripts: {
        updatedAt: 1,
        setup: {
          default: "old setup",
          macos: null,
          windows: null,
          linux: null,
        },
        teardown: {
          default: "old teardown",
          macos: null,
          windows: null,
          linux: null,
        },
      },
    };
    const fixture = createFixture([row("/wt/a", null, "(unresolved)")]);
    fixture.host.selection.set("/wt/a", oldSelection);
    markWorktreeChangedStreamOpen(HOST_ID);
    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, ["/wt/a"], true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("selection-answer"),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);

    const laterListing = {
      ...row("/wt/a", 10, "listing-answer"),
      prState: null,
      owners: [
        {
          epicId: "new-epic",
          ownerKind: "chat" as const,
          ownerId: "new-chat",
          updatedAt: 2,
        },
      ],
      inUse: false,
      scripts: {
        updatedAt: 2,
        setup: {
          default: "new setup",
          macos: null,
          windows: null,
          linux: null,
        },
        teardown: {
          default: "new teardown",
          macos: null,
          windows: null,
          linux: null,
        },
      },
    };
    fixture.host.listing = [laterListing];
    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set(["/wt/a"]),
      });
    });

    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("listing-answer"),
    );
    expect(result.current.worktrees[0]).toMatchObject({
      resolvedAt: 10,
      branch: "listing-answer",
      owners: laterListing.owners,
      inUse: false,
      scripts: laterListing.scripts,
      prState: "open",
      prNumber: 43,
      prUrl: "https://example.test/pull/43",
      branchStatus: { ahead: 3, behind: 1, mergedIntoDefault: false },
    });
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"], ["/wt/a"]]);
  });

  it("answers a root catch-up frame with one listing read and no per-row reads", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/b"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
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
