import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  WorktreeHostEntryV11,
  WorktreeListAllForHostResponseV11,
} from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  useCachedWorktreeEnrichment,
  useWorktreeActivityEnrichment,
} from "@/components/settings/panels/worktrees-enrichment";

const HOST_ID = mockLocalHostEntry.hostId;
// Slightly over the hook's internal 80ms report debounce.
const WORKTREE_DEBOUNCE_SETTLE_MS = 120;

function enrichedEntry(
  worktreePath: string,
  branch: string,
): WorktreeHostEntryV11 {
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
    // A real, host-validated merged status - i.e. fully enriched, not base-only.
    branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
  };
}

const METHOD_SCOPE = hostQueryKeys.methodScope(
  HOST_ID,
  "worktree.listAllForHost",
);

function perPathKey(path: string): readonly unknown[] {
  return [...METHOD_SCOPE, { includeActivity: true, activityPaths: [path] }];
}

function baseKey(): readonly unknown[] {
  return [...METHOD_SCOPE, { includeActivity: false, activityPaths: null }];
}

function seedEnriched(qc: QueryClient, entry: WorktreeHostEntryV11): void {
  qc.setQueryData<WorktreeListAllForHostResponseV11>(
    perPathKey(entry.worktreePath),
    {
      worktrees: [entry],
    },
  );
}

describe("useCachedWorktreeEnrichment (cache-backed overlay)", () => {
  afterEach(() => {
    cleanup();
  });

  it("folds per-path enrichment queries by path and EXCLUDES the base list", () => {
    const qc = new QueryClient();
    const a = enrichedEntry("/wt/a", "feat-a");
    seedEnriched(qc, a);
    // The base list (includeActivity: false) carries a DIFFERENT path's base-only
    // data. It must NOT enter the overlay - else that row would classify from
    // base-only fields instead of staying pending.
    qc.setQueryData<WorktreeListAllForHostResponseV11>(baseKey(), {
      worktrees: [enrichedEntry("/wt/b", "feat-b")],
    });

    const { result } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );

    expect(result.current.get("/wt/a")).toBe(a);
    expect(result.current.has("/wt/b")).toBe(false);
  });

  it("hydrates a warm cache on the FIRST render (no empty→populated flash)", () => {
    const qc = new QueryClient();
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    seedEnriched(qc, enrichedEntry("/wt/b", "feat-b"));

    // No act()/waitFor: the very first snapshot already reflects the warm cache.
    const { result } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );

    expect(result.current.has("/wt/a")).toBe(true);
    expect(result.current.has("/wt/b")).toBe(true);
  });

  it("grows monotonically as new per-path results land, never dropping prior paths", () => {
    const qc = new QueryClient();
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    const { result } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );
    expect(result.current.has("/wt/a")).toBe(true);

    act(() => {
      seedEnriched(qc, enrichedEntry("/wt/c", "feat-c"));
    });

    expect(result.current.has("/wt/a")).toBe(true); // kept
    expect(result.current.has("/wt/c")).toBe(true); // added
  });

  it("returns a referentially STABLE snapshot until a relevant cache event", () => {
    const qc = new QueryClient();
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    const { result, rerender } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );
    const first = result.current;

    // A re-render with no cache change hands back the SAME reference (a fresh
    // object every render would loop `useSyncExternalStore`).
    rerender();
    expect(result.current).toBe(first);

    // An UNRELATED cache event (outside the worktree method scope) must not churn
    // the overlay - the subscribe filter ignores it.
    act(() => {
      qc.setQueryData(hostQueryKeys.methodScope(HOST_ID, "epic.listTasks"), {
        x: 1,
      });
    });
    expect(result.current).toBe(first);
  });
});

describe("useWorktreeActivityEnrichment (window-independent overlay)", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function wrapperFor(qc: QueryClient) {
    return (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={qc}>{props.children}</QueryClientProvider>
    );
  }

  it("keeps a path enriched after it leaves the reported window (anti-oscillation)", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    // Two paths already enriched in the cache (as if fetched moments ago).
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    seedEnriched(qc, enrichedEntry("/wt/b", "feat-b"));

    // client=null / reachable=false: no live fetching, so the ONLY source of the
    // overlay is the cache - proving it is independent of the reported window.
    const { result } = renderHook(
      () => useWorktreeActivityEnrichment(null, false, HOST_ID),
      { wrapper: wrapperFor(qc) },
    );
    expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    expect(result.current.enrichedByPath.has("/wt/b")).toBe(true);

    // The window slides so only /wt/a is on screen; /wt/b leaves it. In the old
    // derived-from-window design this dropped /wt/b from the overlay, reverting it
    // to pending and re-entering under a filter (the 66↔70 flip). Now it persists.
    act(() => {
      result.current.reportVisiblePaths(["/wt/a"]);
      vi.advanceTimersByTime(WORKTREE_DEBOUNCE_SETTLE_MS);
    });

    expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    expect(result.current.enrichedByPath.has("/wt/b")).toBe(true); // ← the fix
  });
});

describe("useWorktreeActivityEnrichment (live fetch → cache → overlay)", () => {
  afterEach(() => {
    cleanup();
  });

  function createFixture(
    entriesByPath: ReadonlyMap<string, WorktreeHostEntryV11>,
  ) {
    const queryClient = new QueryClient();
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "worktree.listAllForHost": (params) => {
            // Per-path enrichment: return the enriched entry for each requested
            // path (the panel always requests exactly one path per query).
            const paths =
              "activityPaths" in params && params.activityPaths !== null
                ? params.activityPaths
                : [];
            return {
              worktrees: paths.flatMap((path) => {
                const entry = entriesByPath.get(path);
                return entry === undefined ? [] : [entry];
              }),
            };
          },
        },
      }),
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    return { client, Wrapper };
  }

  it("enriches a reported window, then keeps it enriched after the window shrinks", async () => {
    const entriesByPath = new Map<string, WorktreeHostEntryV11>([
      ["/wt/a", enrichedEntry("/wt/a", "feat-a")],
      ["/wt/b", enrichedEntry("/wt/b", "feat-b")],
    ]);
    const fixture = createFixture(entriesByPath);
    const { result } = renderHook(
      () => useWorktreeActivityEnrichment(fixture.client, true, HOST_ID),
      { wrapper: fixture.Wrapper },
    );

    // Report both paths on screen → they fetch and land in the overlay.
    act(() => {
      result.current.reportVisiblePaths(["/wt/a", "/wt/b"]);
    });
    await waitFor(() => {
      expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
      expect(result.current.enrichedByPath.has("/wt/b")).toBe(true);
    });

    // /wt/b scrolls off; only /wt/a is reported. Its query goes inactive but stays
    // cached, so the overlay must NOT drop it (no revert-to-pending oscillation).
    act(() => {
      result.current.reportVisiblePaths(["/wt/a"]);
    });
    await new Promise((resolve) =>
      setTimeout(resolve, WORKTREE_DEBOUNCE_SETTLE_MS),
    );
    expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    expect(result.current.enrichedByPath.has("/wt/b")).toBe(true);
  });

  it("still enriches when the first report fires during StrictMode's mount effect cycle (regression: a cleared debounce must re-arm)", async () => {
    // Guards the "second open never enriches" bug. With a WARM base list the
    // panel body and list mount in the same commit, so the list's first
    // visible-paths report fires INSIDE StrictMode's setup→cleanup→setup mount
    // cycle. The hook's unmount cleanup cleared the debounce timer but left the
    // timer id in the ref, permanently wedging the old "skip if a timer is
    // pending" debounce: requestedPaths never committed, no enrichment query
    // was ever created, and every un-cached row spun at "Checking…" forever.
    // The debounce now clears-and-re-arms on every report, so the wedge state
    // is unreachable by construction.
    //
    // HARNESS LIMITATION: this vitest/jsdom setup does not run StrictMode's
    // double-invoked effect cycle (verified empirically - a mount effect under
    // <StrictMode> fires exactly once here), so this test could NOT reproduce
    // the wedge red against the old code. It stays as a canary: it exercises
    // the exact production shape (report from a mount effect under
    // StrictMode), and becomes a real regression net the moment the test
    // runtime gains dev-mode double-invocation.
    const entriesByPath = new Map<string, WorktreeHostEntryV11>([
      ["/wt/a", enrichedEntry("/wt/a", "feat-a")],
    ]);
    const fixture = createFixture(entriesByPath);
    // Mimic the list: report on-screen paths from a MOUNT EFFECT, exactly where
    // StrictMode's double-invoked effect cycle bites.
    function useEnrichmentReportingOnMount() {
      const enrichment = useWorktreeActivityEnrichment(
        fixture.client,
        true,
        HOST_ID,
      );
      const { reportVisiblePaths } = enrichment;
      useEffect(() => {
        reportVisiblePaths(["/wt/a"]);
      }, [reportVisiblePaths]);
      return enrichment;
    }
    const { result } = renderHook(() => useEnrichmentReportingOnMount(), {
      wrapper: (props: { readonly children: ReactNode }): ReactNode => (
        <StrictMode>
          <fixture.Wrapper>{props.children}</fixture.Wrapper>
        </StrictMode>
      ),
    });

    await waitFor(() => {
      expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    });
  });
});
