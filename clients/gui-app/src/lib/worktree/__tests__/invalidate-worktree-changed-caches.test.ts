import { describe, expect, it } from "vitest";
import {
  QueryObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";

const HOST_ID = mockLocalHostEntry.hostId;
const REPO = "/repo";

describe("invalidateWorktreeChangedCaches + branch lists", () => {
  it("refetches a MOUNTED branch list, so the deleted branch actually leaves the source picker", async () => {
    // A real observer, not just `setQueryData`: `isInvalidated` alone cannot
    // tell `refetchType: "active"` from `"none"`, and "the entry was marked"
    // is not the contract - the contract is that the open picker stops offering
    // a branch that no longer exists.
    const queryClient = createAppQueryClient();
    let served: ReadonlyArray<string> = ["main", "feature/login"];
    const observer = new QueryObserver(queryClient, {
      queryKey: branchesKey(REPO),
      queryFn: () => Promise.resolve({ branches: [...served] }),
    });
    const stop = observer.subscribe(() => undefined);
    await waitUntil(() => observer.getCurrentResult().data !== undefined);

    served = ["main"];
    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: true,
      worktreePaths: new Set(),
    });

    await waitUntil(
      () => observer.getCurrentResult().data?.branches.length === 1,
    );
    expect(observer.getCurrentResult().data?.branches).toEqual(["main"]);
    stop();
  });

  it("marks an UNMOUNTED branch list so it re-reads on its next mount", async () => {
    // The branch list lives in a nested form that is usually closed, and the
    // app leaves `refetchOnMount` at its default. `refetchType: "active"` is
    // therefore the right cost here - one refetch per open picker, not one per
    // cached list - and this is the half of that bargain worth pinning.
    const queryClient = createAppQueryClient();
    let served: ReadonlyArray<string> = ["main", "feature/login"];
    let fetches = 0;
    const queryFn = (): Promise<{ branches: ReadonlyArray<string> }> => {
      fetches += 1;
      return Promise.resolve({ branches: [...served] });
    };
    const warm = new QueryObserver(queryClient, {
      queryKey: branchesKey(REPO),
      queryFn,
    });
    const stopWarm = warm.subscribe(() => undefined);
    await waitUntil(() => warm.getCurrentResult().data !== undefined);
    // The form closes: the entry stays cached with no observer.
    stopWarm();
    expect(fetches).toBe(1);

    served = ["main"];
    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: true,
      worktreePaths: new Set(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing refetched while it was unmounted...
    expect(fetches).toBe(1);

    // ...and reopening it re-reads rather than serving the deleted branch.
    const remounted = new QueryObserver(queryClient, {
      queryKey: branchesKey(REPO),
      queryFn,
    });
    const stopRemount = remounted.subscribe(() => undefined);
    await waitUntil(
      () => remounted.getCurrentResult().data?.branches.length === 1,
    );
    expect(fetches).toBe(2);
    stopRemount();
  });

  it("drops the branch list on a worktree-scoped event too, since a checkout re-derives one row", () => {
    const queryClient = createAppQueryClient();
    const branches = seedBranches(queryClient, REPO);

    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: false,
      worktreePaths: new Set([REPO]),
    });

    expect(queryClient.getQueryState(branches)?.isInvalidated).toBe(true);
  });

  it("still drops the workspace summaries the rows render from", () => {
    const queryClient = createAppQueryClient();
    const summaries = seedWorkspaceSummaries(queryClient, REPO);

    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: true,
      worktreePaths: new Set(),
    });

    expect(queryClient.getQueryState(summaries)?.isInvalidated).toBe(true);
  });

  it("leaves another host's branch list alone", () => {
    const queryClient = createAppQueryClient();
    const mine = seedBranches(queryClient, REPO);
    const theirs = hostQueryKeys.method("other-host", "worktree.listBranches", {
      workspacePath: REPO,
      includeRemote: true,
    });
    queryClient.setQueryData(theirs, { branches: [] });

    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: true,
      worktreePaths: new Set(),
    });

    expect(queryClient.getQueryState(mine)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(theirs)?.isInvalidated).toBe(false);
  });
});

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the branch list to settle");
}

function branchesKey(workspacePath: string): QueryKey {
  return hostQueryKeys.method(HOST_ID, "worktree.listBranches", {
    workspacePath,
    includeRemote: true,
  });
}

function seedBranches(
  queryClient: QueryClient,
  workspacePath: string,
): QueryKey {
  const key = hostQueryKeys.method(HOST_ID, "worktree.listBranches", {
    workspacePath,
    includeRemote: true,
  });
  queryClient.setQueryData(key, {
    branches: [
      { name: "feature/login", isCurrent: false, isRemoteOnly: false },
    ],
  });
  return key;
}

function seedWorkspaceSummaries(
  queryClient: QueryClient,
  workspacePath: string,
): QueryKey {
  const key = hostQueryKeys.method(HOST_ID, "worktree.listByWorkspacePaths", {
    workspacePaths: [workspacePath],
    scriptRefs: [],
    forceRefresh: false,
  });
  queryClient.setQueryData(key, { workspaces: [] });
  return key;
}
