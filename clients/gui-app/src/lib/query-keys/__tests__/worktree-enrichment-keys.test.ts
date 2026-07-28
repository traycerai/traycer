import { describe, expect, it } from "vitest";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  isPerPathEnrichmentQueryKey,
  perPathEnrichmentQueryPath,
} from "@/lib/query-keys/worktree-enrichment-keys";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";

const HOST_ID = mockLocalHostEntry.hostId;

describe("perPathEnrichmentQueryPath", () => {
  it("returns the path for a single-path enrichment key (Settings overlay)", () => {
    const key = enrichmentKey(["/wt/app"]);
    expect(perPathEnrichmentQueryPath(key)).toBe("/wt/app");
  });

  it("returns null for a multi-path enrichment key (batch overlay)", () => {
    // Regression: previously returned activityPaths[0], so multi-path batches
    // only invalidated when their first path changed.
    const key = enrichmentKey(["/wt/a", "/wt/b", "/wt/c"]);
    expect(perPathEnrichmentQueryPath(key)).toBeNull();
  });

  it("returns null for the base list (activityPaths: null)", () => {
    const key = hostQueryKeys.method(HOST_ID, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    expect(perPathEnrichmentQueryPath(key)).toBeNull();
  });

  it("returns null for an empty activityPaths array", () => {
    expect(perPathEnrichmentQueryPath(enrichmentKey([]))).toBeNull();
  });
});

describe("isPerPathEnrichmentQueryKey", () => {
  // Deliberately broader than perPathEnrichmentQueryPath: any array is an
  // enrichment payload, including multi-path batches. Do not "fix" this.
  it("is true for single-path and multi-path enrichment keys", () => {
    expect(isPerPathEnrichmentQueryKey(enrichmentKey(["/wt/a"]))).toBe(true);
    expect(isPerPathEnrichmentQueryKey(enrichmentKey(["/wt/a", "/wt/b"]))).toBe(
      true,
    );
  });

  it("is false for the base list (activityPaths: null)", () => {
    const key = hostQueryKeys.method(HOST_ID, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    expect(isPerPathEnrichmentQueryKey(key)).toBe(false);
  });
});

describe("invalidateWorktreeChangedCaches + multi-path enrichment", () => {
  it("invalidates a multi-path batch when ANY of its paths changes", () => {
    const queryClient = createAppQueryClient();
    const multiPath = seedEnrichment(queryClient, ["/wt/a", "/wt/b", "/wt/c"]);
    const singleOther = seedEnrichment(queryClient, ["/wt/other"]);

    // Change only the second path of the multi-path batch. Pre-fix this did
    // not invalidate the batch because only activityPaths[0] was considered.
    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: false,
      worktreePaths: new Set(["/wt/b"]),
    });

    expect(queryClient.getQueryState(multiPath)?.isInvalidated).toBe(true);
    // Settings single-path overlay for an unrelated path stays warm.
    expect(queryClient.getQueryState(singleOther)?.isInvalidated).toBe(false);
  });

  it("invalidates a multi-path batch when its first path changes too", () => {
    const queryClient = createAppQueryClient();
    const multiPath = seedEnrichment(queryClient, ["/wt/a", "/wt/b"]);

    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: false,
      worktreePaths: new Set(["/wt/a"]),
    });

    expect(queryClient.getQueryState(multiPath)?.isInvalidated).toBe(true);
  });

  it("still invalidates only the named single-path overlay (Settings unchanged)", () => {
    const queryClient = createAppQueryClient();
    const named = seedEnrichment(queryClient, ["/wt/app"]);
    const other = seedEnrichment(queryClient, ["/wt/other"]);

    invalidateWorktreeChangedCaches(queryClient, HOST_ID, {
      root: false,
      worktreePaths: new Set(["/wt/app"]),
    });

    expect(queryClient.getQueryState(named)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

function enrichmentKey(activityPaths: readonly string[]): QueryKey {
  return hostQueryKeys.method(HOST_ID, "worktree.listAllForHost", {
    includeActivity: true,
    activityPaths: [...activityPaths],
    cursor: null,
    limit: null,
    forceRefresh: false,
  });
}

function seedEnrichment(
  queryClient: QueryClient,
  activityPaths: readonly string[],
): QueryKey {
  const key = enrichmentKey(activityPaths);
  queryClient.setQueryData(key, { worktrees: [], nextCursor: null });
  return key;
}
