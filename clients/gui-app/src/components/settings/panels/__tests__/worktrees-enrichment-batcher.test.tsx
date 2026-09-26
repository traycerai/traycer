import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  WorktreeHostEntryV16,
  WorktreeListAllForHostResponseV14,
} from "@traycer/protocol/host/worktree-schemas";
import {
  createWorktreeEnrichmentBatcher,
  WORKTREE_ENRICH_BATCH_LIMIT,
  type WorktreeEnrichmentBatcher,
  perPathEnrichmentQueryKey,
} from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useWorktreeEnrichmentForClient } from "@/hooks/worktree/use-worktree-enrichment-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * R2 coverage: the host answers a selection-mode row under
 * `path.resolve` of the requested spelling. A binding-sourced request that
 * still carries a trailing slash (an explicit `worktree.import` persists the
 * caller's raw string) gets the host's un-slashed row back - previously the
 * batcher's exact-string fan-out dropped it.
 */

function hostRow(worktreePath: string, branch: string): WorktreeHostEntryV16 {
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
    resolvedAt: 1,
    presence: "present",
    gitUnreadable: false,
  };
}

afterEach(() => {
  cleanup();
});

/** The Settings chunk size, which these fan-out cases do not depend on. */
function batcherOf(
  requestBatch: (
    paths: readonly string[],
  ) => Promise<WorktreeListAllForHostResponseV14>,
): WorktreeEnrichmentBatcher {
  return createWorktreeEnrichmentBatcher(
    requestBatch,
    WORKTREE_ENRICH_BATCH_LIMIT,
  );
}

describe("createWorktreeEnrichmentBatcher - path-match fan-out", () => {
  it("resolves a trailing-slash request with the host's un-slashed row", async () => {
    const batcher = batcherOf((paths) => {
      expect(paths).toEqual(["/wt/app/"]);
      return Promise.resolve({
        worktrees: [hostRow("/wt/app", "feature/login")],
        nextCursor: null,
      });
    });

    const response = await batcher.fetchPath("/wt/app/");

    expect(response.worktrees).toHaveLength(1);
    expect(response.worktrees[0]?.worktreePath).toBe("/wt/app");
    expect(response.worktrees[0]?.branch).toBe("feature/login");
  });

  it("still resolves an exact request to its exact row, ahead of any lexical match in the same batch", async () => {
    const batcher = batcherOf((paths) => {
      expect(paths).toEqual(["/wt/app", "/wt/app/"]);
      return Promise.resolve({
        worktrees: [hostRow("/wt/app", "feature/login")],
        nextCursor: null,
      });
    });

    const [exact, trailingSlash] = await Promise.all([
      batcher.fetchPath("/wt/app"),
      batcher.fetchPath("/wt/app/"),
    ]);

    expect(exact.worktrees.map((row) => row.worktreePath)).toEqual(["/wt/app"]);
    expect(trailingSlash.worktrees.map((row) => row.worktreePath)).toEqual([
      "/wt/app",
    ]);
  });

  it("resolves a requested path with no matching row (exact or lexical) to an empty listing", async () => {
    const batcher = batcherOf(() =>
      Promise.resolve({ worktrees: [], nextCursor: null }),
    );

    const response = await batcher.fetchPath("/wt/missing");

    expect(response.worktrees).toEqual([]);
  });
});

describe("useWorktreeEnrichmentForClient - resolves a binding-sourced trailing slash", () => {
  it("lands the host's row under the per-path key for the trailing-slash request", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "worktree.listAllForHost": (params) =>
          Promise.resolve({
            worktrees: (params.activityPaths ?? []).map(() =>
              hostRow("/wt/app", "feature/login"),
            ),
            nextCursor: null,
          }),
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

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(client, ["/wt/app/"], true),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.worktrees).toHaveLength(1);
    });
    expect(result.current.worktrees[0]?.worktreePath).toBe("/wt/app");

    const hostId = client.getActiveHostId();
    const cached = queryClient.getQueryData<{
      readonly worktrees: readonly WorktreeHostEntryV16[];
    }>(perPathEnrichmentQueryKey(hostId, "/wt/app/"));
    expect(cached?.worktrees).toHaveLength(1);
    expect(cached?.worktrees[0]?.worktreePath).toBe("/wt/app");
  });
});
