import { afterEach, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
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
    invalidateWorktreeChangedCaches(queryClient, mockLocalHostEntry.hostId);
  });

  await waitFor(() => {
    expect(result.current.worktrees[0]?.branch).toBe("fresh");
  });
  expect(requests).toEqual([false, false]);
  expect(queryClient.getQueryCache().findAll({ queryKey: scope })).toHaveLength(
    1,
  );
});
