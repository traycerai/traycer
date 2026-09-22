import { afterEach, describe, expect, it } from "vitest";
import {
  QueryClientProvider,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import { useTaskWorktreeMetadataForClient } from "@/hooks/worktree/use-task-worktree-metadata-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  createWorktreeChangedInvalidationScheduler,
  WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
  WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
} from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * Regression coverage for the History worktree amplification loop: a
 * per-path `worktree.changed` frame used to widen `useTaskWorktreeMetadata`'s
 * refetch to the WHOLE multi-path enrichment key it read (every owned row,
 * re-derived - spawning git for all of them), instead of just the one row the
 * frame named.
 *
 * Against the pre-fix code, (mount), (a), (b) and (d) ALL fail on their
 * assertions: the old hook read ONE `activityPaths: ownedPaths` key rather
 * than one batched call per 8 owned paths, so (mount) alone already
 * mismatches (1 selection call, not 4); and the old invalidator refetched any
 * multi-path key on every path frame - so a frame for one row, or for a row
 * not on the page at all, re-requested all 27 paths. (c) is the control and
 * passes on both: a root frame re-reads every owned row either way.
 *
 * Every count is read only once NOTHING is fetching. A per-path refetch waits
 * in the batcher's coalescing window before its RPC is sent, so asserting as
 * soon as the base call lands would pass vacuously over a regression that is
 * still queued.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-1";
const EPIC_OTHER = "epic-other";
const OWNED_COUNT = 27;
const OTHER_COUNT = 3;
const BATCH_LIMIT = 8;

const OWNED_PATHS: readonly string[] = Array.from(
  { length: OWNED_COUNT },
  (_, index) => `/wt/owned-${String(index)}`,
);
const OTHER_PATHS: readonly string[] = Array.from(
  { length: OTHER_COUNT },
  (_, index) => `/wt/other-${String(index)}`,
);
const UNLISTED_PATH = "/wt/does-not-exist";

interface ListAllForHostCall {
  readonly includeActivity: boolean;
  readonly activityPaths: readonly string[] | null;
  readonly cursor: string | null;
  readonly limit: number | null;
  readonly forceRefresh: boolean;
}

afterEach(() => {
  cleanup();
});

function perPathKey(path: string): QueryKey {
  return hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
    HOST_ID,
    "worktree.listAllForHost",
    {
      includeActivity: true,
      activityPaths: [path],
      cursor: null,
      limit: null,
      forceRefresh: false,
    },
  );
}

function entryRow(path: string, epicId: string): WorktreeHostEntryV16 {
  return {
    worktreePath: path,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch: "main",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [
      { epicId, ownerKind: "chat", ownerId: `chat-${path}`, updatedAt: 1 },
    ],
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

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly calls: (
    predicate: (call: ListAllForHostCall) => boolean,
  ) => readonly ListAllForHostCall[];
  readonly clearCalls: () => void;
}

function createFixture(): Fixture {
  const queryClient = createAppQueryClient();
  const recorded: ListAllForHostCall[] = [];
  const baseRows: readonly WorktreeHostEntryV16[] = [
    ...OWNED_PATHS.map((path) => entryRow(path, EPIC_ID)),
    ...OTHER_PATHS.map((path) => entryRow(path, EPIC_OTHER)),
  ];
  const rowsByPath = new Map(baseRows.map((row) => [row.worktreePath, row]));

  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${String(recorded.length)}`,
    handlers: {
      "worktree.listAllForHost": (params) => {
        recorded.push(params);
        if (params.activityPaths === null) {
          return Promise.resolve({
            worktrees: [...baseRows],
            nextCursor: null,
          });
        }
        const worktrees = params.activityPaths.flatMap((path) => {
          const row = rowsByPath.get(path);
          return row === undefined ? [] : [row];
        });
        return Promise.resolve({ worktrees, nextCursor: null });
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
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
    client,
    queryClient,
    Wrapper,
    calls: (predicate) => recorded.filter(predicate),
    clearCalls: () => {
      recorded.length = 0;
    },
  };
}

async function mountAndSettle(fixture: Fixture) {
  const rendered = renderHook(
    () => useTaskWorktreeMetadataForClient(fixture.client, [EPIC_ID]),
    { wrapper: fixture.Wrapper },
  );
  await waitFor(() => {
    expect(rendered.result.current.worktreesByEpicId.get(EPIC_ID)).toHaveLength(
      OWNED_COUNT,
    );
  });
  await settled(fixture);
  return rendered;
}

/** Resolves once every query the burst started has settled and been recorded. */
async function settled(fixture: Fixture): Promise<void> {
  await waitFor(() => {
    expect(fixture.queryClient.isFetching()).toBe(0);
  });
}

function baseCallsOf(fixture: Fixture): readonly ListAllForHostCall[] {
  return fixture.calls((call) => call.activityPaths === null);
}

function selectionCallsOf(fixture: Fixture): readonly ListAllForHostCall[] {
  return fixture.calls((call) => call.activityPaths !== null);
}

describe("useTaskWorktreeMetadataForClient - worktree.changed frame refetch cost", () => {
  it("(mount) costs exactly one base call and one selection call per 8 owned paths, covering every owned path once", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);

    const base = baseCallsOf(fixture);
    const selection = selectionCallsOf(fixture);

    expect(base).toHaveLength(1);
    expect(selection).toHaveLength(Math.ceil(OWNED_COUNT / BATCH_LIMIT));
    for (const call of selection) {
      expect(call.activityPaths).not.toBeNull();
      expect((call.activityPaths ?? []).length).toBeLessThanOrEqual(
        BATCH_LIMIT,
      );
    }
    const union = selection.flatMap((call) => call.activityPaths ?? []);
    expect(union.length).toBe(OWNED_COUNT);
    expect(new Set(union).size).toBe(OWNED_COUNT);
    expect([...union].sort()).toEqual([...OWNED_PATHS].sort());
  });

  it("(a) a path frame for one on-screen path refetches only that path's per-path query", async () => {
    const fixture = createFixture();
    const rendered = await mountAndSettle(fixture);
    fixture.clearCalls();

    const target = OWNED_PATHS[0];
    const untouched = OWNED_PATHS.slice(1);
    const beforeTarget =
      fixture.queryClient.getQueryState(perPathKey(target))?.dataUpdateCount ??
      0;
    const beforeOthers = new Map(
      untouched.map((path) => [
        path,
        fixture.queryClient.getQueryState(perPathKey(path))?.dataUpdateCount ??
          0,
      ]),
    );

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set([target]),
      });
    });

    await waitFor(() => {
      expect(selectionCallsOf(fixture)).toHaveLength(1);
    });
    await settled(fixture);

    // The wire first: this is what the host pays for.
    const selection = selectionCallsOf(fixture);
    expect(selection).toHaveLength(1);
    expect(selection[0]?.activityPaths).toEqual([target]);
    expect(baseCallsOf(fixture)).toHaveLength(1);

    // Then the cache: that row's query refetched once, no other row's did.
    expect(
      fixture.queryClient.getQueryState(perPathKey(target))?.dataUpdateCount,
    ).toBe(beforeTarget + 1);
    for (const path of untouched) {
      expect(
        fixture.queryClient.getQueryState(perPathKey(path))?.dataUpdateCount,
      ).toBe(beforeOthers.get(path));
    }
    // Still mounted with the same 27 owned rows - the burst didn't drop
    // anything from the page.
    expect(rendered.result.current.worktreesByEpicId.get(EPIC_ID)).toHaveLength(
      OWNED_COUNT,
    );
  });

  it("(a) two path frames in the same flush give ONE selection call with exactly both paths", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);
    fixture.clearCalls();

    const first = OWNED_PATHS[0];
    const second = OWNED_PATHS[1];

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set([first, second]),
      });
    });

    await waitFor(() => {
      expect(selectionCallsOf(fixture)).toHaveLength(1);
    });
    await settled(fixture);
    const selection = selectionCallsOf(fixture);
    expect(selection).toHaveLength(1);
    expect([...(selection[0]?.activityPaths ?? [])].sort()).toEqual(
      [first, second].sort(),
    );
    expect(baseCallsOf(fixture)).toHaveLength(1);
  });

  it("(b) a frame naming an off-screen owned path, and one the host does not list at all, issues zero selection calls and exactly one base call", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);
    fixture.clearCalls();

    const offScreenOwned = OTHER_PATHS[0];
    const seededKey = perPathKey(offScreenOwned);
    fixture.queryClient.setQueryData(seededKey, {
      worktrees: [],
      nextCursor: null,
    });
    const seededUpdateCount =
      fixture.queryClient.getQueryState(seededKey)?.dataUpdateCount;

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set([offScreenOwned, UNLISTED_PATH]),
      });
    });

    await waitFor(() => {
      expect(baseCallsOf(fixture)).toHaveLength(1);
    });
    await settled(fixture);
    expect(baseCallsOf(fixture)).toHaveLength(1);
    expect(selectionCallsOf(fixture)).toHaveLength(0);

    // Marked, never fetched: the observer-less entry is invalidated but its
    // dataUpdateCount and fetchStatus never move.
    expect(fixture.queryClient.getQueryState(seededKey)?.isInvalidated).toBe(
      true,
    );
    expect(fixture.queryClient.getQueryState(seededKey)?.dataUpdateCount).toBe(
      seededUpdateCount,
    );
    expect(fixture.queryClient.getQueryState(seededKey)?.fetchStatus).toBe(
      "idle",
    );
  });

  it("(c) control: a root frame gives exactly one base call and its selection calls cover every owned path exactly once (green on both old and new code)", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);
    fixture.clearCalls();

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: true,
        worktreePaths: new Set(),
      });
    });

    await waitFor(() => {
      expect(baseCallsOf(fixture)).toHaveLength(1);
    });
    await waitFor(() => {
      const union = selectionCallsOf(fixture).flatMap(
        (call) => call.activityPaths ?? [],
      );
      expect(new Set(union).size).toBe(OWNED_COUNT);
    });
    await settled(fixture);
    expect(baseCallsOf(fixture)).toHaveLength(1);
    const selection = selectionCallsOf(fixture);
    const union = selection.flatMap((call) => call.activityPaths ?? []);
    expect([...union].sort()).toEqual([...OWNED_PATHS].sort());
    // R6: still bounded by the batch size, even though this control
    // deliberately does not pin the exact selection-call count.
    expect(selection.length).toBeLessThanOrEqual(
      Math.ceil(OWNED_COUNT / BATCH_LIMIT),
    );
  });

  it("(d) coalesces a burst of path frames (10×P1, 5×P2, 3×off-screen Q) inside the debounce window into one flush: one base call and one selection call covering exactly {P1,P2}", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);
    fixture.clearCalls();

    const p1 = OWNED_PATHS[0];
    const p2 = OWNED_PATHS[1];
    const q = OTHER_PATHS[0];

    const scheduler = createWorktreeChangedInvalidationScheduler({
      onFlush: (scopes) =>
        invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, scopes),
      debounceMs: WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
      maxWaitMs: WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
    });

    for (let i = 0; i < 10; i += 1) {
      scheduler.push({ kind: "worktreePath", worktreePath: p1 });
    }
    for (let i = 0; i < 5; i += 1) {
      scheduler.push({ kind: "worktreePath", worktreePath: p2 });
    }
    for (let i = 0; i < 3; i += 1) {
      scheduler.push({ kind: "worktreePath", worktreePath: q });
    }

    await waitFor(
      () => {
        expect(baseCallsOf(fixture)).toHaveLength(1);
      },
      { timeout: WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS + 2_000 },
    );
    await waitFor(() => {
      expect(selectionCallsOf(fixture)).toHaveLength(1);
    });
    await settled(fixture);
    expect(baseCallsOf(fixture)).toHaveLength(1);
    const selection = selectionCallsOf(fixture);
    expect(selection).toHaveLength(1);
    expect([...(selection[0]?.activityPaths ?? [])].sort()).toEqual(
      [p1, p2].sort(),
    );

    scheduler.dispose();
  });
});
