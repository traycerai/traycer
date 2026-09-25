import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import {
  createWorktreeEnrichmentBatcher,
  WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT,
  WORKTREE_ENRICH_BATCH_LIMIT,
} from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useWorktreeEnrichmentForClient } from "@/hooks/worktree/use-worktree-enrichment-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * The background enrichment surfaces (History, the Epic sweep row, owner
 * cards) read activity rows per path through ONE batcher per host client, in
 * chunks larger than the Settings panel's, and treat a row as fresh for five
 * minutes - so a navigation that mounts several of them, or remounts one, no
 * longer sends a burst of small `worktree.listAllForHost` calls.
 */

function hostRow(worktreePath: string): WorktreeHostEntryV16 {
  return {
    worktreePath,
    branch: "feature",
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

function paths(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `/wt/${prefix}-${index}`);
}

interface Fixture {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  /** `activityPaths` of every selection-mode call, in order. */
  readonly calls: string[][];
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createFixture(): Fixture {
  const queryClient = createAppQueryClient();
  const calls: string[][] = [];
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
          // The paged listing names none of these paths, so each is read by
          // selection - the batching these tests are about.
          if (params.activityPaths === null) {
            return Promise.resolve({ worktrees: [], nextCursor: null });
          }
          const requested = params.activityPaths;
          calls.push([...requested]);
          return Promise.resolve({
            worktrees: requested.map(hostRow),
            nextCursor: null,
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  // One requester for the fixture: the batcher is shared per client, so each
  // test builds its own spine and never inherits another test's batcher.
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { queryClient, client, calls, Wrapper };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("background worktree enrichment", () => {
  it("puts two surfaces' paths, mounted together, into the same call", async () => {
    const fixture = createFixture();
    const history = paths("history", 5);
    const sweepRow = paths("sweep", 3);

    const { result } = renderHook(
      () => ({
        history: useWorktreeEnrichmentForClient(fixture.client, history, true),
        sweepRow: useWorktreeEnrichmentForClient(
          fixture.client,
          sweepRow,
          true,
        ),
      }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(result.current.history.worktrees).toHaveLength(5);
      expect(result.current.sweepRow.worktrees).toHaveLength(3);
    });
    expect(fixture.calls).toHaveLength(1);
    expect([...fixture.calls[0]].sort()).toEqual(
      [...history, ...sweepRow].sort(),
    );
  });

  it("reads a large task page in background-sized chunks, not the Settings chunk", async () => {
    const fixture = createFixture();
    const page = paths("page", 40);

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, page, true),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.worktrees).toHaveLength(40));
    expect(fixture.calls.map((call) => call.length)).toEqual([
      WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT,
      40 - WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT,
    ]);
  });

  it("does not re-read on a remount within five minutes, and does after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture();
    const owned = paths("owned", 3);
    const mount = () =>
      renderHook(
        () => useWorktreeEnrichmentForClient(fixture.client, owned, true),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(3));
    first.unmount();
    expect(fixture.calls).toHaveLength(1);

    // Past the app's one-minute default: a navigation used to re-probe here.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees).toHaveLength(3),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.calls).toHaveLength(1);
    second.unmount();

    vi.setSystemTime(Date.now() + 4 * 60_000);
    const third = mount();
    await waitFor(() => expect(fixture.calls).toHaveLength(2));
    third.unmount();
  });
});

describe("createWorktreeEnrichmentBatcher chunk size", () => {
  it("chunks at the limit it is given", async () => {
    const calls: number[] = [];
    const batcher = createWorktreeEnrichmentBatcher((requested) => {
      calls.push(requested.length);
      return Promise.resolve({ worktrees: [], nextCursor: null });
    }, WORKTREE_ENRICH_BATCH_LIMIT);

    await Promise.all(paths("settings", 10).map(batcher.fetchPath));

    expect(calls).toEqual([WORKTREE_ENRICH_BATCH_LIMIT, 2]);
  });
});
