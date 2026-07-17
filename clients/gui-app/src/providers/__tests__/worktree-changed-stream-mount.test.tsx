import { afterEach, expect, it } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host";
import { useWorktreeListing } from "@/components/settings/panels/worktrees-listing-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function entry(branch: string): WorktreeHostEntryV14 {
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
  };
}

it("refetches a changed worktree event into the active canonical cache entry without forcing", async () => {
  const requests: boolean[] = [];
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
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
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
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
      kind: "worktreePath",
      worktreePath: "/wt/app",
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
    kind: "worktreePath",
    worktreePath: "/wt/app",
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
    kind: "root",
    root: "/repo",
  });

  expect(queryClient.getQueryState(named)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
});
