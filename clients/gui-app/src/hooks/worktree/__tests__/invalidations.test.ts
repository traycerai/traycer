import { describe, expect, it } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";

const HOST_ID = mockLocalHostEntry.hostId;
const DELETED_PATH = "/repo/wt/deleted";
const UNRELATED_PATH = "/repo/wt/untouched";

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the query to settle");
}

function bindingsKey(runningDir: string) {
  return hostQueryKeys.method(HOST_ID, "worktree.listBindingsForEpic", {
    epicId: `epic-for-${runningDir}`,
  });
}

function managedWorktreeRow(
  runningDir: string,
  worktreePath: string,
  workspacePath: string,
): {
  readonly mode: "worktree";
  readonly isImported: boolean;
  readonly runningDir: string;
  readonly worktreePath: string;
  readonly workspacePath: string;
} {
  return {
    mode: "worktree",
    isImported: false,
    runningDir,
    worktreePath,
    workspacePath,
  };
}

/**
 * H5: a delete/sweep used to refetch every cached worktree-picker key on the
 * host regardless of whether it named the deleted path, and regardless of
 * whether anything was even observing it. This pins the fix at its own owner
 * boundary - the sibling `invalidate-worktree-changed-caches.test.ts` already
 * covers the shared `affectedWorktreeQueryKeys` membership matcher in depth,
 * so this stays lean: only `invalidateWorktreeListingAndBindingCaches`'s own
 * contract (active-only refetch, narrowed by membership) is under test here.
 */
describe("invalidateWorktreeListingAndBindingCaches", () => {
  it("refetches a MOUNTED listBindingsForEpic entry whose cached row names the deleted path", async () => {
    const queryClient = createAppQueryClient();
    let served: ReadonlyArray<{
      readonly runningDir: string;
      readonly worktreePath: string | null;
      readonly workspacePath: string;
    }> = [
      {
        runningDir: DELETED_PATH,
        worktreePath: DELETED_PATH,
        workspacePath: "/repo",
      },
    ];
    let fetches = 0;
    const key = bindingsKey(DELETED_PATH);
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({ rows: [...served] });
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitUntil(() => observer.getCurrentResult().data !== undefined);
    expect(fetches).toBe(1);

    served = [];
    invalidateWorktreeListingAndBindingCaches(queryClient, HOST_ID, [
      DELETED_PATH,
    ]);

    await waitUntil(() => fetches === 2);
    stop();
  });

  it("does not mark or refetch a MOUNTED entry whose cached row names an unrelated path", async () => {
    // H5: only a genuinely managed row (mode 'worktree', isImported false, a
    // concrete worktreePath) has certain-enough path identity for a lexical
    // miss to mean "unrelated" - a row missing that provenance would be
    // conservatively included regardless of path, so this fixture states it
    // explicitly rather than leaving it absent.
    const queryClient = createAppQueryClient();
    let fetches = 0;
    const key = bindingsKey(UNRELATED_PATH);
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({
          rows: [managedWorktreeRow(UNRELATED_PATH, UNRELATED_PATH, "/repo")],
        });
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitUntil(() => observer.getCurrentResult().data !== undefined);
    expect(fetches).toBe(1);

    invalidateWorktreeListingAndBindingCaches(queryClient, HOST_ID, [
      DELETED_PATH,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetches).toBe(1);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    stop();
  });

  it("conservatively refreshes a MOUNTED entry for an imported row whose path does not lexically match", async () => {
    const queryClient = createAppQueryClient();
    let fetches = 0;
    const key = bindingsKey(UNRELATED_PATH);
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({
          rows: [
            {
              mode: "worktree" as const,
              isImported: true,
              runningDir: "/alias/group/feature",
              worktreePath: "/alias/group/feature",
              workspacePath: "/alias/group/feature",
            },
          ],
        });
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitUntil(() => observer.getCurrentResult().data !== undefined);
    expect(fetches).toBe(1);

    invalidateWorktreeListingAndBindingCaches(queryClient, HOST_ID, [
      DELETED_PATH,
    ]);

    await waitUntil(() => fetches === 2);
    stop();
  });

  it("conservatively refreshes a MOUNTED entry for a local row with no worktreePath to compare", async () => {
    const queryClient = createAppQueryClient();
    let fetches = 0;
    const key = bindingsKey(UNRELATED_PATH);
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({
          rows: [
            {
              mode: "local" as const,
              isImported: false,
              runningDir: "/alias/group/feature-local",
              worktreePath: null,
              workspacePath: "/alias/group/feature-local",
            },
          ],
        });
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitUntil(() => observer.getCurrentResult().data !== undefined);
    expect(fetches).toBe(1);

    invalidateWorktreeListingAndBindingCaches(queryClient, HOST_ID, [
      DELETED_PATH,
    ]);

    await waitUntil(() => fetches === 2);
    stop();
  });

  it("marks but does not refetch an INACTIVE (unmounted) entry matching the deleted path, leaving it to refresh on its next mount", async () => {
    const queryClient = createAppQueryClient();
    let fetches = 0;
    const key = bindingsKey(DELETED_PATH);
    const queryFn = (): Promise<{
      rows: ReadonlyArray<{
        runningDir: string;
        worktreePath: string | null;
        workspacePath: string;
      }>;
    }> => {
      fetches += 1;
      return Promise.resolve({
        rows: [
          {
            runningDir: DELETED_PATH,
            worktreePath: DELETED_PATH,
            workspacePath: "/repo",
          },
        ],
      });
    };
    const warm = new QueryObserver(queryClient, { queryKey: key, queryFn });
    const stopWarm = warm.subscribe(() => undefined);
    await waitUntil(() => warm.getCurrentResult().data !== undefined);
    stopWarm();
    expect(fetches).toBe(1);

    invalidateWorktreeListingAndBindingCaches(queryClient, HOST_ID, [
      DELETED_PATH,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetches).toBe(1);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("leaves another host's matching entry untouched", () => {
    const queryClient = createAppQueryClient();
    const mine = bindingsKey(DELETED_PATH);
    queryClient.setQueryData(mine, {
      rows: [
        {
          runningDir: DELETED_PATH,
          worktreePath: DELETED_PATH,
          workspacePath: "/repo",
        },
      ],
    });
    const theirs = hostQueryKeys.method(
      "other-host",
      "worktree.listBindingsForEpic",
      {
        epicId: "epic-for-other-host",
      },
    );
    queryClient.setQueryData(theirs, {
      rows: [
        {
          runningDir: DELETED_PATH,
          worktreePath: DELETED_PATH,
          workspacePath: "/repo",
        },
      ],
    });

    invalidateWorktreeListingAndBindingCaches(queryClient, HOST_ID, [
      DELETED_PATH,
    ]);

    expect(queryClient.getQueryState(mine)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(theirs)?.isInvalidated).toBe(false);
  });
});
