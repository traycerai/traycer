import { afterEach, describe, expect, it } from "vitest";
import { WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT } from "@/components/settings/panels/worktrees-enrichment-batcher";
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
import { perPathEnrichmentQueryKey } from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useTaskWorktreeMetadataForClient } from "@/hooks/worktree/use-task-worktree-metadata-query";
import { resetWorktreePullRequestTouchesForTests } from "@/hooks/worktree/use-worktree-enrichment-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  createWorktreeChangedInvalidationScheduler,
  WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS,
  WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS,
} from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * What `worktree.changed` frames cost `useTaskWorktreeMetadata` (History and the
 * Epic sweep row), on the wire.
 *
 * The rows come from the ONE host listing (paged, never spawning git), so a
 * frame - for a row, for several, or for the root - costs exactly one base
 * listing call: the host re-derived the named rows before it published, and the
 * listing carries them. No frame costs a selection-mode read (the kind that
 * derives), which is what used to turn History's frames into per-row git work.
 * The only selection read on mount is the PR-freshness touch, once per host
 * per interval.
 *
 * Every count is read only once NOTHING is fetching. A selection read waits in
 * the batcher's coalescing window before its RPC is sent, so asserting as soon
 * as the base call lands would pass vacuously over one still queued.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-1";
const EPIC_OTHER = "epic-other";
const OWNED_COUNT = 27;
const OTHER_COUNT = 3;
// The background surfaces' chunk (History, the Epic sweep row), not Settings'.
const BATCH_LIMIT = WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT;

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
  resetWorktreePullRequestTouchesForTests();
});

function perPathKey(path: string): QueryKey {
  return perPathEnrichmentQueryKey(HOST_ID, path);
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
  it("(mount) costs exactly one base call, and one PR-touch selection batch covering every owned path once", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);

    const base = baseCallsOf(fixture);
    const selection = selectionCallsOf(fixture);

    // The rows themselves come from the one base listing; the only selection
    // read is the PR-freshness touch, due on the host's first mount.
    expect(base).toHaveLength(1);
    expect(selection).toHaveLength(Math.ceil(OWNED_COUNT / BATCH_LIMIT));
    for (const call of selection) {
      expect((call.activityPaths ?? []).length).toBeLessThanOrEqual(
        BATCH_LIMIT,
      );
    }
    const union = selection.flatMap((call) => call.activityPaths ?? []);
    expect([...union].sort()).toEqual([...OWNED_PATHS].sort());
  });

  it("(a) a path frame for an on-screen path costs exactly one base call and no selection call", async () => {
    const fixture = createFixture();
    const rendered = await mountAndSettle(fixture);
    fixture.clearCalls();

    const target = OWNED_PATHS[0];
    const before = new Map(
      OWNED_PATHS.map((path) => [
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
      expect(baseCallsOf(fixture)).toHaveLength(1);
    });
    await settled(fixture);

    // The host re-derived the row before publishing, so the base listing
    // carries it; nothing re-derives on a selection read.
    expect(baseCallsOf(fixture)).toHaveLength(1);
    expect(selectionCallsOf(fixture)).toHaveLength(0);
    for (const path of OWNED_PATHS) {
      expect(
        fixture.queryClient.getQueryState(perPathKey(path))?.dataUpdateCount ??
          0,
      ).toBe(before.get(path));
    }
    expect(rendered.result.current.worktreesByEpicId.get(EPIC_ID)).toHaveLength(
      OWNED_COUNT,
    );
  });

  it("(a) two path frames in the same flush still cost one base call and no selection call", async () => {
    const fixture = createFixture();
    await mountAndSettle(fixture);
    fixture.clearCalls();

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set([OWNED_PATHS[0], OWNED_PATHS[1]]),
      });
    });

    await waitFor(() => {
      expect(baseCallsOf(fixture)).toHaveLength(1);
    });
    await settled(fixture);
    expect(baseCallsOf(fixture)).toHaveLength(1);
    expect(selectionCallsOf(fixture)).toHaveLength(0);
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

  it("(c) a root frame costs exactly one base call and no selection call", async () => {
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
    await settled(fixture);
    expect(baseCallsOf(fixture)).toHaveLength(1);
    expect(selectionCallsOf(fixture)).toHaveLength(0);
  });

  it("(d) coalesces a burst of path frames (10×P1, 5×P2, 3×off-screen Q) inside the debounce window into one flush: one base call and no selection call", async () => {
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
    await settled(fixture);
    expect(baseCallsOf(fixture)).toHaveLength(1);
    expect(selectionCallsOf(fixture)).toHaveLength(0);

    scheduler.dispose();
  });
});
