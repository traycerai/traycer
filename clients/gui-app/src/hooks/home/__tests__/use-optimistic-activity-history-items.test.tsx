import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  historyActivitySnapshot,
  observeActiveHistoryEdges,
  observeOwnHistoryRecordChange,
  projectOptimisticHistoryItems,
  requestHistoryActivityRefresh,
  settleHistoryActivity,
  useOptimisticActivityHistoryItems,
} from "@/hooks/home/use-optimistic-activity-history-items";

const hookState = vi.hoisted(() => ({
  workingEpicIds: new Set<string>(),
  contextRequests: [] as string[][],
  contexts: new Map<string, ListTaskLight>(),
  cachedContexts: new Map<string, ListTaskLight>(),
  useCachedContexts: false,
  contextRefetchCalls: 0,
  contextRefetchBatches: [] as string[][],
}));

vi.mock("@/stores/use-own-turn-epic-ids", () => ({
  useOwnTurnEpicIds: () => hookState.workingEpicIds,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  authorizesCloudCapability: () => true,
  useAuthStore: (selector: (state: { status: string }) => boolean) =>
    selector({ status: "authenticated" }),
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: (ids: readonly string[]) => {
    hookState.contextRequests.push([...ids]);
    const contexts = hookState.useCachedContexts
      ? hookState.cachedContexts
      : hookState.contexts;
    const refetchIds = (taskIds: readonly string[]): Promise<void> => {
      if (!hookState.useCachedContexts || taskIds.length === 0)
        return Promise.resolve();
      hookState.contextRefetchCalls += 1;
      hookState.contextRefetchBatches.push([...taskIds]);
      const refreshed = new Map(hookState.cachedContexts);
      for (const id of taskIds) {
        const task = hookState.contexts.get(id);
        if (task === undefined) refreshed.delete(id);
        else refreshed.set(id, task);
      }
      hookState.cachedContexts = refreshed;
      return Promise.resolve();
    };
    return {
      tasksById: new Map(
        ids.flatMap((id) => {
          const task = contexts.get(id);
          return task === undefined ? [] : [[id, task] as const];
        }),
      ),
      localHomedTaskIds: new Set<string>(),
      refetch: () => refetchIds(ids),
      refetchBatches:
        ids.length === 0
          ? []
          : [{ taskIds: [...ids], refetch: () => refetchIds(ids) }],
    };
  },
}));

function historyItem(
  epicId: string,
  updatedAtMs: number,
  recentAtMs: number | undefined,
): HistoryItem {
  const effectiveRecentAtMs = recentAtMs ?? updatedAtMs;
  return {
    id: epicId,
    epicId,
    taskType: "epic",
    title: epicId,
    initialUserPrompt: "",
    updatedAtMs,
    updatedLabel: "old edit",
    updatedBucket: "earlier",
    recentAtMs: effectiveRecentAtMs,
    recentLabel: "old activity",
    recentBucket: "earlier",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
  };
}

/** The hook's projection, over the snapshot its store subscription reads. */
function project(
  userId: string,
  pageItems: readonly HistoryItem[],
  backfilled: readonly HistoryItem[],
  nowMs: number,
): readonly HistoryItem[] {
  return projectOptimisticHistoryItems(historyActivitySnapshot().stamps, {
    userId,
    pageItems,
    backfilled,
    nowMs,
  });
}

function taskContext(epicId: string): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: epicId,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 10,
        updatedAt: 20,
        createdBy: "owner",
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  hookState.workingEpicIds = new Set();
  hookState.contextRequests = [];
  hookState.contexts = new Map();
  hookState.cachedContexts = new Map();
  hookState.useCachedContexts = false;
  hookState.contextRefetchCalls = 0;
  hookState.contextRefetchBatches = [];
});

describe("optimistic activity history projection", () => {
  it("stamps a new active edge once and does not re-arm after durable catch-up", () => {
    const userId = `stable-${crypto.randomUUID()}`;
    const working = new Set(["active-epic"]);

    expect(observeActiveHistoryEdges(userId, working, 100)).toBe(true);
    expect(observeActiveHistoryEdges(userId, working, 200)).toBe(false);

    settleHistoryActivity(userId, [historyItem("active-epic", 150, 100)]);
    expect(observeActiveHistoryEdges(userId, working, 300)).toBe(false);

    expect(observeActiveHistoryEdges(userId, new Set(), 400)).toBe(false);
    expect(observeActiveHistoryEdges(userId, working, 500)).toBe(true);
  });

  it("limits optimistic stamps to the newest 64 active rows", () => {
    const userId = `bounded-${crypto.randomUUID()}`;
    const ids = Array.from({ length: 70 }, (_, index) => `epic-${index}`);
    expect(observeActiveHistoryEdges(userId, new Set(ids), 1000)).toBe(true);

    const projected = project(
      userId,
      ids.map((id) => historyItem(id, 1, undefined)),
      [],
      1000,
    );
    expect(projected).toHaveLength(70);
    expect(projected.filter((item) => item.recentAtMs === 1000)).toHaveLength(
      64,
    );
  });

  it("publishes nothing when an unchanged active set exceeds the latch cap", () => {
    // One more viewer-owned active task than the 256 active-edge latches. A
    // latch evicted while its id is still active is admitted again as a new
    // edge on the next observation, evicting the next one: every observation
    // of the same set would publish a snapshot and re-run the observing effect.
    const userId = `latch-cap-${crypto.randomUUID()}`;
    const ids = Array.from(
      { length: 257 },
      (_, index) => `latch-${String(index).padStart(3, "0")}`,
    );
    let publications = 0;
    // A passive subscriber: only a published snapshot re-renders it.
    renderHook(() => {
      publications += 1;
      return useOptimisticActivityHistoryItems({
        items: [],
        userId: null,
        hostId: null,
        enabled: false,
        refetch: () => Promise.resolve(),
      });
    });
    const observe = (
      working: ReadonlySet<string>,
      at: number,
    ): { readonly added: boolean; readonly published: number } => {
      const before = publications;
      let added = false;
      act(() => {
        added = observeActiveHistoryEdges(userId, working, at);
      });
      return { added, published: publications - before };
    };

    expect(observe(new Set(ids), 1_000)).toEqual({ added: true, published: 1 });
    expect(observe(new Set(ids), 2_000)).toEqual({
      added: false,
      published: 0,
    });

    // The surplus id waits, in a stable order, until an active latch frees.
    const freed = new Set(ids.filter((id) => id !== "latch-000"));
    expect(observe(freed, 3_000)).toEqual({ added: true, published: 1 });
    const [surplus] = project(
      userId,
      [historyItem("latch-256", 1, undefined)],
      [],
      3_000,
    );
    expect(surplus.recentAtMs).toBe(3_000);
    expect(observe(freed, 4_000)).toEqual({ added: false, published: 0 });
  });

  it("prioritizes a pending own-record id within the 64-row backfill cap", () => {
    const userId = `retained-backfill-cap-${crypto.randomUUID()}`;
    const workingIds = Array.from(
      { length: 64 },
      (_, index) => `working-${index}`,
    );
    hookState.workingEpicIds = new Set(workingIds);
    observeOwnHistoryRecordChange(userId, "retained-off-page", 1_000);

    renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-retained-backfill-cap",
        enabled: true,
        refetch: vi.fn(() => Promise.resolve()),
      }),
    );

    const requestedIds = hookState.contextRequests.at(-1);
    expect(requestedIds).toHaveLength(64);
    expect(requestedIds).toContain("retained-off-page");
  });

  it("projects active timestamps into Recent ordering and removes them at durable catch-up", () => {
    const userId = `ordering-${crypto.randomUUID()}`;
    const working = new Set(["active-a", "active-b"]);
    observeActiveHistoryEdges(userId, working, 300);
    const pageItems = [
      historyItem("older", 250, undefined),
      historyItem("active-a", 100, undefined),
    ];
    const backfilled = [historyItem("active-b", 50, undefined)];

    const projected = project(userId, pageItems, backfilled, 300);
    expect(projected.map((item) => item.epicId)).toEqual([
      "active-b",
      "active-a",
      "older",
    ]);
    expect(projected[0].recentAtMs).toBe(300);
    expect(projected[1].recentAtMs).toBe(300);

    settleHistoryActivity(userId, [historyItem("active-a", 100, 300)]);
    const afterFirstKey = project(userId, pageItems, backfilled, 300);
    expect(
      afterFirstKey.find((item) => item.epicId === "active-a")?.recentAtMs,
    ).toBe(300);

    settleHistoryActivity(userId, [historyItem("active-a", 100, 301)]);
    const afterCatchUp = project(userId, pageItems, backfilled, 300);
    expect(
      afterCatchUp.find((item) => item.epicId === "active-a")?.recentAtMs,
    ).toBe(100);
    expect(
      afterCatchUp.find((item) => item.epicId === "active-b")?.recentAtMs,
    ).toBe(300);
  });

  it("keeps a pending edge when the server clock is ahead of the browser", () => {
    const userId = `server-clock-ahead-${crypto.randomUUID()}`;
    const epicId = "server-clock-ahead-epic";
    const baseline = historyItem(epicId, 20_000, 20_000);
    settleHistoryActivity(userId, [baseline]);
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);

    settleHistoryActivity(userId, [baseline]);
    const olderDurableRow = historyItem(epicId, 9_000, 9_000);
    expect(project(userId, [olderDurableRow], [], 20_000)[0]?.recentAtMs).toBe(
      10_000,
    );

    settleHistoryActivity(userId, [historyItem(epicId, 21_000, 21_000)]);
    expect(project(userId, [olderDurableRow], [], 21_000)[0]?.recentAtMs).toBe(
      9_000,
    );
  });

  it("keeps an accepted record pending until a newer durable key arrives", () => {
    const userId = `accepted-behind-durable-${crypto.randomUUID()}`;
    const epicId = "accepted-behind-durable-epic";
    const baseline = historyItem(epicId, 20_000, 20_000);
    const olderDurableRow = historyItem(epicId, 9_000, 9_000);
    settleHistoryActivity(userId, [baseline]);
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);
    observeOwnHistoryRecordChange(userId, epicId, 3_000);

    settleHistoryActivity(userId, [baseline]);
    expect(project(userId, [olderDurableRow], [], 20_000)[0]?.recentAtMs).toBe(
      10_000,
    );

    settleHistoryActivity(userId, [historyItem(epicId, 21_000, 21_000)]);
    expect(project(userId, [olderDurableRow], [], 21_000)[0]?.recentAtMs).toBe(
      9_000,
    );
  });

  it("uses the first off-page durable key as a baseline before settling", () => {
    const userId = `off-page-baseline-${crypto.randomUUID()}`;
    const epicId = "off-page-baseline-epic";
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);

    settleHistoryActivity(userId, [historyItem(epicId, 20_000, 20_000)]);
    const olderCachedRow = historyItem(epicId, 9_000, 9_000);
    expect(project(userId, [olderCachedRow], [], 20_000)[0]?.recentAtMs).toBe(
      10_000,
    );

    settleHistoryActivity(userId, [historyItem(epicId, 21_000, 21_000)]);
    expect(project(userId, [olderCachedRow], [], 21_000)[0]?.recentAtMs).toBe(
      9_000,
    );
  });

  it("uses the first durable key as baseline after an own-record event", () => {
    const userId = `own-off-page-baseline-${crypto.randomUUID()}`;
    const epicId = "own-off-page-baseline-epic";
    observeOwnHistoryRecordChange(userId, epicId, 3_000);
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);

    settleHistoryActivity(userId, [historyItem(epicId, 20_000, 20_000)]);
    const olderCachedRow = historyItem(epicId, 1_000, 1_000);
    expect(project(userId, [olderCachedRow], [], 20_000)[0]?.recentAtMs).toBe(
      10_000,
    );

    settleHistoryActivity(userId, [historyItem(epicId, 21_000, 21_000)]);
    expect(project(userId, [olderCachedRow], [], 21_000)[0]?.recentAtMs).toBe(
      1_000,
    );
  });

  it("settles the first durable key accepted after an off-page active edge", () => {
    const userId = `edge-before-own-off-page-${crypto.randomUUID()}`;
    const epicId = "edge-before-own-off-page-epic";
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);
    observeOwnHistoryRecordChange(userId, epicId, 3_000);

    settleHistoryActivity(userId, [historyItem(epicId, 3_000, 3_000)]);
    const olderCachedRow = historyItem(epicId, 1_000, 1_000);
    expect(project(userId, [olderCachedRow], [], 10_000)[0]?.recentAtMs).toBe(
      1_000,
    );
  });

  it("settles a baseline key when its own-record event arrives afterward", () => {
    const userId = `page-before-own-record-${crypto.randomUUID()}`;
    const epicId = "page-before-own-record-epic";
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);
    const firstDurablePage = [historyItem(epicId, 3_000, 3_000)];
    settleHistoryActivity(userId, firstDurablePage);

    observeOwnHistoryRecordChange(userId, epicId, 3_000);
    settleHistoryActivity(userId, firstDurablePage);

    expect(
      project(userId, [historyItem(epicId, 1_000, 1_000)], [], 10_000)[0]
        ?.recentAtMs,
    ).toBe(1_000);
  });

  it("keeps an own-record stamp pending when the pre-edge baseline is unchanged", () => {
    const userId = `pre-edge-baseline-${crypto.randomUUID()}`;
    const epicId = "pre-edge-baseline-epic";
    const baselinePage = [historyItem(epicId, 3_000, 3_000)];
    settleHistoryActivity(userId, baselinePage);

    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);
    observeOwnHistoryRecordChange(userId, epicId, 3_000);
    settleHistoryActivity(userId, baselinePage);

    expect(
      project(userId, [historyItem(epicId, 1_000, 1_000)], [], 10_000)[0]
        ?.recentAtMs,
    ).toBe(10_000);
  });

  it("does not settle a legacy row from updatedAt without durable recency", () => {
    const userId = `legacy-recency-${crypto.randomUUID()}`;
    const epicId = "legacy-recency-epic";
    observeActiveHistoryEdges(userId, new Set([epicId]), 10_000);
    const advancedLegacyRow = {
      ...historyItem(epicId, 20_000, 1_000),
      recentAtMs: undefined,
    };

    settleHistoryActivity(userId, [advancedLegacyRow]);

    expect(
      project(
        userId,
        [{ ...historyItem(epicId, 9_000, 9_000), recentAtMs: undefined }],
        [],
        10_000,
      )[0]?.recentAtMs,
    ).toBe(10_000);
  });

  it("preserves server order for unstamped old-peer rows when lifting a stamped row", () => {
    const userId = `server-order-${crypto.randomUUID()}`;
    const authoritativeItems = [
      { ...historyItem("server-first", 100, undefined), recentAtMs: undefined },
      {
        ...historyItem("server-second", 300, undefined),
        recentAtMs: undefined,
      },
    ];

    expect(
      project(userId, authoritativeItems, [], 1_000).map((item) => item.epicId),
    ).toEqual(["server-first", "server-second"]);

    observeOwnHistoryRecordChange(userId, "stamped-old-peer", 500);
    const projected = project(
      userId,
      authoritativeItems,
      [historyItem("stamped-old-peer", 50, undefined)],
      1_000,
    );

    expect(projected.map((item) => item.epicId)).toEqual([
      "stamped-old-peer",
      "server-first",
      "server-second",
    ]);
  });

  it("requests missing active rows in one context batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    hookState.workingEpicIds = new Set(["missing-a", "missing-b"]);
    const userId = `batch-${crypto.randomUUID()}`;
    const refetch = vi.fn(() => Promise.resolve());

    renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-test",
        enabled: true,
        refetch,
      }),
    );

    expect(hookState.contextRequests.length).toBeGreaterThan(0);
    expect(hookState.contextRequests.at(-1)).toEqual([
      "missing-a",
      "missing-b",
    ]);
    expect(hookState.contextRequests.every((ids) => ids.length === 2)).toBe(
      true,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("settles a stamped backfill when its durable key advances", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `backfill-catch-up-${crypto.randomUUID()}`;
    const epicId = "backfill-catch-up-epic";
    settleHistoryActivity(userId, [historyItem(epicId, 1_000, 1_000)]);
    hookState.workingEpicIds = new Set([epicId]);
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 1_000,
    });

    const { result, rerender } = renderHook(
      ({ revision }) => {
        void revision;
        return useOptimisticActivityHistoryItems({
          items: [],
          userId,
          hostId: "host-backfill-catch-up",
          enabled: true,
          refetch: vi.fn(() => Promise.resolve()),
        });
      },
      { initialProps: { revision: 0 } },
    );

    expect(result.current[0]?.epicId).toBe(epicId);
    expect(result.current[0]?.recentAtMs).toBe(10_000);

    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 2_000,
    });
    rerender({ revision: 1 });

    expect(result.current[0]?.recentAtMs).toBe(2_000);
  });

  it("does not rehydrate an idle row after the list acknowledges its context key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `list-ack-retirement-${crypto.randomUUID()}`;
    const epicId = "list-ack-retirement-epic";
    settleHistoryActivity(userId, [historyItem(epicId, 500, 500)]);
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 2_000,
    });
    const { result, rerender } = renderHook(
      ({ items, revision }) => {
        void revision;
        return useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-list-ack-retirement",
          enabled: true,
          refetch: vi.fn(() => Promise.resolve()),
        });
      },
      { initialProps: { items: [] as readonly HistoryItem[], revision: 0 } },
    );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 1_000));
    expect(result.current[0]?.recentAtMs).toBe(2_000);

    rerender({
      items: [historyItem(epicId, 2_000, 2_000)],
      revision: 1,
    });
    rerender({ items: [], revision: 2 });

    expect(result.current.map((item) => item.epicId)).not.toContain(epicId);
  });

  it("refetches one cached context batch during off-page reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `cached-context-reconcile-${crypto.randomUUID()}`;
    const epicId = "cached-context-reconcile-epic";
    const staleContext = { ...taskContext(epicId), recentAt: 500 };
    settleHistoryActivity(userId, [historyItem(epicId, 500, 500)]);
    hookState.useCachedContexts = true;
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 2_000,
    });
    hookState.cachedContexts.set(epicId, staleContext);
    const refetch = vi.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(
      ({ revision }) => {
        void revision;
        return useOptimisticActivityHistoryItems({
          items: [],
          userId,
          hostId: "host-cached-context-reconcile",
          enabled: true,
          refetch,
        });
      },
      { initialProps: { revision: 0 } },
    );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 1_000));
    expect(result.current[0]?.recentAtMs).toBe(1_000);
    expect(hookState.contextRefetchCalls).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    rerender({ revision: 1 });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(hookState.contextRefetchCalls).toBe(1);
    expect(hookState.contextRequests.at(-1)).toEqual([epicId]);
    expect(result.current[0]?.recentAtMs).toBe(2_000);
  });

  it("uses the injecting consumer context batch for a shared scope refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `shared-injecting-context-${crypto.randomUUID()}`;
    const epicId = "shared-injecting-context-epic";
    settleHistoryActivity(userId, [historyItem(epicId, 500, 500)]);
    hookState.useCachedContexts = true;
    const staleContext = { ...taskContext(epicId), recentAt: 500 };
    hookState.contexts.set(epicId, { ...taskContext(epicId), recentAt: 2_000 });
    hookState.cachedContexts.set(epicId, staleContext);
    const injectingRefetch = vi.fn(() => Promise.resolve());
    const nonInjectingRefetch = vi.fn(() => Promise.resolve());
    const { result: injectingResult, rerender: rerenderInjecting } = renderHook(
      ({ revision }) => {
        void revision;
        return useOptimisticActivityHistoryItems({
          items: [],
          userId,
          hostId: "host-shared-injecting-context",
          enabled: true,
          refreshEnabled: true,
          refreshScope: "recent:all",
          refetch: injectingRefetch,
        });
      },
      { initialProps: { revision: 0 } },
    );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 1_000));
    const nonInjecting = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-shared-injecting-context",
        enabled: false,
        refreshEnabled: true,
        refreshScope: "recent:all",
        refetch: nonInjectingRefetch,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    rerenderInjecting({ revision: 1 });

    expect(
      injectingRefetch.mock.calls.length +
        nonInjectingRefetch.mock.calls.length,
    ).toBe(1);
    expect(hookState.contextRefetchBatches).toEqual([[epicId]]);
    expect(injectingResult.current[0]?.recentAtMs).toBe(2_000);
    nonInjecting.unmount();
  });

  it("deduplicates a shared context batch and keeps it after one consumer unmounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `overlapping-context-refresh-${crypto.randomUUID()}`;
    const epicId = "overlapping-context-refresh-epic";
    settleHistoryActivity(userId, [historyItem(epicId, 500, 500)]);
    hookState.useCachedContexts = true;
    hookState.cachedContexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 500,
    });
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 2_000,
    });
    const firstRefetch = vi.fn(() => Promise.resolve());
    const secondRefetch = vi.fn(() => Promise.resolve());
    const first = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-overlapping-context-refresh",
        enabled: true,
        refreshScope: "recent:all",
        refetch: firstRefetch,
      }),
    );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 1_000));
    const second = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-overlapping-context-refresh",
        enabled: true,
        refreshScope: "recent:all",
        refetch: secondRefetch,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    second.rerender();

    expect(
      firstRefetch.mock.calls.length + secondRefetch.mock.calls.length,
    ).toBe(1);
    expect(hookState.contextRefetchBatches).toEqual([[epicId]]);
    expect(second.result.current[0]?.recentAtMs).toBe(2_000);

    first.unmount();
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 3_000,
    });
    act(() => observeOwnHistoryRecordChange(userId, epicId, 3_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    second.rerender();

    expect(
      firstRefetch.mock.calls.length + secondRefetch.mock.calls.length,
    ).toBe(2);
    expect(hookState.contextRefetchBatches).toEqual([[epicId], [epicId]]);
    expect(second.result.current[0]?.recentAtMs).toBe(3_000);
  });

  it("refreshes distinct overlapping context batches once per surviving subscriber", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `overlapping-context-batches-${crypto.randomUUID()}`;
    const ids = ["batch-a", "batch-b", "batch-c"];
    for (const epicId of ids) {
      settleHistoryActivity(userId, [historyItem(epicId, 500, 500)]);
      hookState.cachedContexts.set(epicId, {
        ...taskContext(epicId),
        recentAt: 500,
      });
      hookState.contexts.set(epicId, {
        ...taskContext(epicId),
        recentAt: 2_000,
      });
    }
    hookState.useCachedContexts = true;
    const firstRefetch = vi.fn(() => Promise.resolve());
    const secondRefetch = vi.fn(() => Promise.resolve());
    const first = renderHook(
      ({ items }) =>
        useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-overlapping-context-batches",
          enabled: true,
          refreshScope: "recent:all",
          refetch: firstRefetch,
        }),
      {
        initialProps: {
          items: [historyItem("batch-c", 500, 500)],
        },
      },
    );
    const second = renderHook(
      ({ items }) =>
        useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-overlapping-context-batches",
          enabled: true,
          refreshScope: "recent:all",
          refetch: secondRefetch,
        }),
      {
        initialProps: {
          items: [historyItem("batch-a", 500, 500)],
        },
      },
    );
    act(() => {
      for (const epicId of ids) {
        observeOwnHistoryRecordChange(userId, epicId, 1_000);
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(
      firstRefetch.mock.calls.length + secondRefetch.mock.calls.length,
    ).toBe(1);
    expect(hookState.contextRefetchBatches).toEqual([
      ["batch-a", "batch-b"],
      ["batch-b", "batch-c"],
    ]);

    second.rerender({ items: [historyItem("batch-a", 2_000, 2_000)] });
    first.unmount();
    hookState.contexts.set("batch-c", {
      ...taskContext("batch-c"),
      recentAt: 3_000,
    });
    act(() => observeOwnHistoryRecordChange(userId, "batch-c", 3_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    second.rerender({ items: [historyItem("batch-a", 2_000, 2_000)] });

    expect(
      firstRefetch.mock.calls.length + secondRefetch.mock.calls.length,
    ).toBe(2);
    expect(hookState.contextRefetchBatches).toEqual([
      ["batch-a", "batch-b"],
      ["batch-b", "batch-c"],
      ["batch-b", "batch-c"],
    ]);
    expect(
      second.result.current.find((item) => item.epicId === "batch-c")
        ?.recentAtMs,
    ).toBe(3_000);
  });

  it("keeps an acknowledged context key until the page catches up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `context-page-catch-up-${crypto.randomUUID()}`;
    const epicId = "context-page-catch-up-epic";
    settleHistoryActivity(userId, [historyItem(epicId, 1_000, 1_000)]);
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 1_000,
    });
    const { result, rerender } = renderHook(
      ({ items, revision }) => {
        void revision;
        return useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-context-page-catch-up",
          enabled: true,
          refetch: vi.fn(() => Promise.resolve()),
        });
      },
      {
        initialProps: {
          items: [] as readonly HistoryItem[],
          revision: 0,
        },
      },
    );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 3_000));
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 3_000,
    });
    rerender({ items: [], revision: 1 });
    expect(result.current[0]?.recentAtMs).toBe(3_000);

    rerender({
      items: [historyItem(epicId, 2_000, 2_000)],
      revision: 2,
    });
    expect(result.current[0]?.recentAtMs).toBe(3_000);

    rerender({
      items: [historyItem(epicId, 3_000, 3_000)],
      revision: 3,
    });
    expect(result.current[0]?.recentAtMs).toBe(3_000);

    rerender({
      items: [historyItem(epicId, 4_000, 4_000)],
      revision: 4,
    });
    expect(result.current[0]?.recentAtMs).toBe(4_000);
  });

  it("keeps unfiltered context retention when a filtered scope catches up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `cross-scope-retention-${crypto.randomUUID()}`;
    const epicId = "cross-scope-retention-epic";
    settleHistoryActivity(userId, [historyItem(epicId, 1_000, 1_000)]);
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 1_000,
    });
    const { result: unfilteredResult, rerender: rerenderUnfiltered } =
      renderHook(
        ({ revision }) => {
          void revision;
          return useOptimisticActivityHistoryItems({
            items: [],
            userId,
            hostId: "host-cross-scope-retention",
            enabled: true,
            refreshScope: "recent:all",
            refetch: vi.fn(() => Promise.resolve()),
          });
        },
        { initialProps: { revision: 0 } },
      );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 3_000));
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 3_000,
    });
    rerenderUnfiltered({ revision: 1 });
    expect(unfilteredResult.current[0]?.epicId).toBe(epicId);

    const { rerender: rerenderFiltered } = renderHook(
      ({ items }) =>
        useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-cross-scope-retention",
          enabled: false,
          refreshEnabled: true,
          refreshScope: "recent:filtered",
          refetch: vi.fn(() => Promise.resolve()),
        }),
      {
        initialProps: {
          items: [historyItem(epicId, 3_000, 3_000)],
        },
      },
    );
    rerenderFiltered({ items: [historyItem(epicId, 3_000, 3_000)] });
    rerenderUnfiltered({ revision: 2 });

    expect(unfilteredResult.current[0]?.epicId).toBe(epicId);
    expect(unfilteredResult.current[0]?.recentAtMs).toBe(3_000);
  });

  it("keeps an idle active row while the outbox is delayed, retries, then settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `delayed-${crypto.randomUUID()}`;
    hookState.workingEpicIds = new Set(["delayed-epic"]);
    hookState.contexts.set("delayed-epic", taskContext("delayed-epic"));
    const refetch = vi.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(
      ({ working, items }) => {
        hookState.workingEpicIds = working;
        return useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-delayed",
          enabled: true,
          refetch,
        });
      },
      {
        initialProps: {
          working: new Set(["delayed-epic"]),
          items: [] as readonly HistoryItem[],
        },
      },
    );

    rerender({ working: new Set(), items: [] });

    expect(hookState.contextRequests.at(-1)).toEqual(["delayed-epic"]);
    expect(result.current.map((item) => item.epicId)).toContain("delayed-epic");
    expect(result.current[0]?.recentAtMs).toBe(10_000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refetch).toHaveBeenCalledTimes(2);

    rerender({
      working: new Set(),
      items: [historyItem("delayed-epic", 11_000, 10_500)],
    });
    expect(result.current[0]?.recentAtMs).toBe(10_500);
  });

  it("settles only rows whose durable recency changed after the active edge", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `clock-skew-${crypto.randomUUID()}`;
    const initialItems = [
      historyItem("changed-durable", 1_000, 1_000),
      historyItem("unchanged-durable", 1_000, 1_000),
    ];
    hookState.workingEpicIds = new Set();
    const { result, rerender } = renderHook(
      ({ working, items }) => {
        hookState.workingEpicIds = working;
        return useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-clock-skew",
          enabled: true,
          refetch: vi.fn(() => Promise.resolve()),
        });
      },
      { initialProps: { working: new Set<string>(), items: initialItems } },
    );

    rerender({
      working: new Set(["changed-durable", "unchanged-durable"]),
      items: initialItems,
    });
    rerender({ working: new Set(), items: initialItems });

    expect(
      result.current.find((item) => item.epicId === "changed-durable")
        ?.recentAtMs,
    ).toBe(10_000);
    expect(
      result.current.find((item) => item.epicId === "unchanged-durable")
        ?.recentAtMs,
    ).toBe(10_000);

    rerender({
      working: new Set(),
      items: [
        historyItem("changed-durable", 2_000, 2_000),
        historyItem("unchanged-durable", 1_000, 1_000),
      ],
    });

    expect(
      result.current.find((item) => item.epicId === "changed-durable")
        ?.recentAtMs,
    ).toBe(2_000);
    expect(
      result.current.find((item) => item.epicId === "unchanged-durable")
        ?.recentAtMs,
    ).toBe(10_000);
  });

  it("waits for the accepted own-record timestamp before settling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `accepted-at-${crypto.randomUUID()}`;
    const initialItems = [historyItem("accepted-epic", 1_000, 1_000)];
    const { result, rerender } = renderHook(
      ({ working, items }) => {
        hookState.workingEpicIds = working;
        return useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-accepted-at",
          enabled: true,
          refetch: vi.fn(() => Promise.resolve()),
        });
      },
      { initialProps: { working: new Set<string>(), items: initialItems } },
    );

    rerender({
      working: new Set(["accepted-epic"]),
      items: initialItems,
    });
    rerender({ working: new Set(), items: initialItems });
    act(() => observeOwnHistoryRecordChange(userId, "accepted-epic", 3_000));

    rerender({
      working: new Set(),
      items: [historyItem("accepted-epic", 2_000, 2_000)],
    });
    expect(result.current[0]?.recentAtMs).toBe(10_000);

    rerender({
      working: new Set(),
      items: [historyItem("accepted-epic", 3_000, 3_000)],
    });
    expect(result.current[0]?.recentAtMs).toBe(3_000);
  });

  it("preserves an earlier accepted timestamp when the active edge arrives later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const userId = `accepted-before-edge-${crypto.randomUUID()}`;
    const initialItems = [historyItem("accepted-before-edge", 1_000, 1_000)];
    const { result, rerender } = renderHook(
      ({ items }) =>
        useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-accepted-before-edge",
          enabled: true,
          refetch: vi.fn(() => Promise.resolve()),
        }),
      { initialProps: { items: initialItems } },
    );

    act(() =>
      observeOwnHistoryRecordChange(userId, "accepted-before-edge", 3_000),
    );
    act(() => {
      observeActiveHistoryEdges(
        userId,
        new Set(["accepted-before-edge"]),
        10_000,
      );
    });

    rerender({
      items: [historyItem("accepted-before-edge", 2_000, 2_000)],
    });
    expect(result.current[0]?.recentAtMs).toBe(10_000);

    rerender({
      items: [historyItem("accepted-before-edge", 3_000, 3_000)],
    });
    expect(result.current[0]?.recentAtMs).toBe(10_000);

    rerender({
      items: [historyItem("accepted-before-edge", 4_000, 4_000)],
    });
    expect(result.current[0]?.recentAtMs).toBe(4_000);
  });

  it("refreshes once when two consumers share the same user and host scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const userId = `shared-${crypto.randomUUID()}`;
    requestHistoryActivityRefresh(userId);
    const firstRefetch = vi.fn(() => Promise.resolve());
    const secondRefetch = vi.fn(() => Promise.resolve());

    const first = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-shared",
        enabled: true,
        refetch: firstRefetch,
      }),
    );
    const second = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-shared",
        enabled: true,
        refetch: secondRefetch,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(
      firstRefetch.mock.calls.length + secondRefetch.mock.calls.length,
    ).toBe(1);
    first.unmount();
    second.unmount();
  });

  it("does not replay a completed generation when a scope remounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(22_000);
    const userId = `remount-settled-${crypto.randomUUID()}`;
    const refetch = vi.fn(() => Promise.resolve());
    const renderScope = () =>
      renderHook(() =>
        useOptimisticActivityHistoryItems({
          items: [historyItem("epic-a", 1, 22_000)],
          userId,
          hostId: "host-remount-settled",
          enabled: true,
          refreshScope: "recent:all",
          refetch,
        }),
      );

    settleHistoryActivity(userId, [historyItem("epic-a", 1, 21_000)]);
    observeOwnHistoryRecordChange(userId, "epic-a", 22_000);
    const first = renderScope();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750 + 2_000 + 5_000);
    });
    expect(refetch).toHaveBeenCalledTimes(3);
    first.unmount();

    const second = renderScope();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750 + 2_000 + 5_000);
    });
    expect(refetch).toHaveBeenCalledTimes(3);

    act(() => observeOwnHistoryRecordChange(userId, "epic-a", Date.now()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(refetch).toHaveBeenCalledTimes(4);
    second.unmount();
  });

  it("restarts a canceled refresh when a scope remounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(23_000);
    const userId = `remount-canceled-${crypto.randomUUID()}`;
    const refetch = vi.fn(() => Promise.resolve());
    const renderScope = () =>
      renderHook(() =>
        useOptimisticActivityHistoryItems({
          items: [],
          userId,
          hostId: "host-remount-canceled",
          enabled: true,
          refreshScope: "recent:all",
          refetch,
        }),
      );

    observeOwnHistoryRecordChange(userId, "epic-a", 23_000);
    const first = renderScope();
    first.unmount();

    const second = renderScope();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it("uses a nonzero retry delay when a new edge arrives during an in-flight refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(25_000);
    const userId = `in-flight-edge-${crypto.randomUUID()}`;
    let resolveFirst: (() => void) | undefined;
    const refetch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-in-flight-edge",
        enabled: true,
        refetch,
      }),
    );

    act(() => requestHistoryActivityRefresh(userId));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() => requestHistoryActivityRefresh(userId));
    if (resolveFirst === undefined) throw new Error("refetch did not start");
    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a new generation after the third in-flight request settles elsewhere", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(25_000);
    const userId = `third-in-flight-${crypto.randomUUID()}`;
    let requests = 0;
    let resolveThird: (() => void) | undefined;
    const refetch = vi.fn(() => {
      requests += 1;
      return requests === 3
        ? new Promise<void>((resolve) => {
            resolveThird = resolve;
          })
        : Promise.resolve();
    });
    renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-third-in-flight",
        enabled: false,
        refreshEnabled: true,
        refreshScope: "filtered-recent",
        refetch,
      }),
    );

    act(() => observeOwnHistoryRecordChange(userId, "changed-epic", 25_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750 + 2_000 + 5_000);
    });
    expect(refetch).toHaveBeenCalledTimes(3);
    if (resolveThird === undefined)
      throw new Error("third refetch did not start");

    const newerAt = Date.now();
    act(() => observeOwnHistoryRecordChange(userId, "changed-epic", newerAt));
    act(() =>
      settleHistoryActivity(userId, [historyItem("changed-epic", 1, newerAt)]),
    );
    await act(async () => {
      resolveThird?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refetch).toHaveBeenCalledTimes(4);
  });

  it("keeps an acknowledged backfill visible after a stale in-flight page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(25_000);
    const userId = `backfill-stale-page-${crypto.randomUUID()}`;
    const epicId = "backfill-stale-page-epic";
    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 500,
    });
    let requests = 0;
    let resolveThird: (() => void) | undefined;
    const refetch = vi.fn(() => {
      requests += 1;
      return requests === 3
        ? new Promise<void>((resolve) => {
            resolveThird = resolve;
          })
        : Promise.resolve();
    });
    const stalePage: readonly HistoryItem[] = [];
    const { result, rerender } = renderHook(
      ({ items, revision }) => {
        void revision;
        return useOptimisticActivityHistoryItems({
          items,
          userId,
          hostId: "host-backfill-stale-page",
          enabled: true,
          refreshScope: "recent:all",
          refetch,
        });
      },
      { initialProps: { items: stalePage, revision: 0 } },
    );

    act(() => observeOwnHistoryRecordChange(userId, epicId, 1_000));
    expect(result.current.map((item) => item.epicId)).toContain(epicId);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750 + 2_000 + 5_000);
    });
    expect(refetch).toHaveBeenCalledTimes(3);
    if (resolveThird === undefined)
      throw new Error("third refetch did not start");

    hookState.contexts.set(epicId, {
      ...taskContext(epicId),
      recentAt: 3_000,
    });
    rerender({ items: stalePage, revision: 1 });
    expect(result.current.map((item) => item.epicId)).toContain(epicId);

    await act(async () => {
      resolveThird?.();
      await Promise.resolve();
      rerender({ items: stalePage, revision: 2 });
    });
    expect(result.current.map((item) => item.epicId)).toContain(epicId);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refetch).toHaveBeenCalledTimes(4);
  });

  it("keeps ownerless removal refreshes retrying until the bounded TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const userId = `ownerless-removal-${crypto.randomUUID()}`;
    const refetch = vi.fn(() => Promise.resolve());
    renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [],
        userId,
        hostId: "host-ownerless-removal",
        enabled: true,
        refetch,
      }),
    );

    act(() => requestHistoryActivityRefresh(userId));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    const requestsAtTtl = refetch.mock.calls.length;
    expect(requestsAtTtl).toBeGreaterThan(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refetch).toHaveBeenCalledTimes(requestsAtTtl);
  });

  it("refreshes a scope when it becomes enabled after an own idle record change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const userId = `reenabled-${crypto.randomUUID()}`;
    const refetch = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      ({ enabled }) =>
        useOptimisticActivityHistoryItems({
          items: [],
          userId,
          hostId: "host-reenabled",
          enabled,
          refetch,
        }),
      { initialProps: { enabled: false } },
    );

    act(() => observeOwnHistoryRecordChange(userId, "idle-epic", 30_000));
    rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("expires a mounted optimistic stamp at its TTL without a new edge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const userId = `ttl-${crypto.randomUUID()}`;
    hookState.workingEpicIds = new Set(["ttl-epic"]);
    const refetch = vi.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [historyItem("ttl-epic", 1, undefined)],
        userId,
        hostId: "host-ttl",
        enabled: true,
        refetch,
      }),
    );
    expect(result.current[0]?.recentAtMs).toBe(100);

    hookState.workingEpicIds = new Set();
    rerender();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_001);
    });

    expect(result.current[0]?.recentAtMs).toBe(1);
  });

  it("does not renew an expired stamp while the same turn stays active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const userId = `active-ttl-${crypto.randomUUID()}`;
    hookState.workingEpicIds = new Set(["active-ttl-epic"]);
    const { result } = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [historyItem("active-ttl-epic", 1, undefined)],
        userId,
        hostId: "host-active-ttl",
        enabled: true,
        refetch: () => Promise.resolve(),
      }),
    );
    expect(result.current[0]?.recentAtMs).toBe(100);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_001);
    });

    expect(result.current[0]?.recentAtMs).toBe(1);
    expect(
      observeActiveHistoryEdges(userId, hookState.workingEpicIds, Date.now()),
    ).toBe(false);
  });

  it("refreshes when an own record delta arrives for an idle task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const userId = `idle-delta-${crypto.randomUUID()}`;
    const refetch = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: [historyItem("idle-epic", 5, undefined)],
        userId,
        hostId: "host-idle-delta",
        enabled: true,
        refetch,
      }),
    );

    act(() => observeOwnHistoryRecordChange(userId, "idle-epic", 40_000));

    expect(result.current[0]?.recentAtMs).toBe(40_000);
    expect(result.current[0]?.recentLabel).toBe("just now");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes filtered Recent without projecting rows and isolates each consumer scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const userId = `filtered-refresh-${crypto.randomUUID()}`;
    const filteredItems: readonly HistoryItem[] = [];
    const unfilteredItems = [historyItem("idle-epic", 5, undefined)];
    const filteredRefetch = vi.fn(() => Promise.resolve());
    const recentRefetch = vi.fn(() => Promise.resolve());
    const filtered = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: filteredItems,
        userId,
        hostId: "host-filtered-refresh",
        enabled: false,
        refreshEnabled: true,
        refreshScope: "recent:query-filter",
        refetch: filteredRefetch,
      }),
    );
    const unfiltered = renderHook(() =>
      useOptimisticActivityHistoryItems({
        items: unfilteredItems,
        userId,
        hostId: "host-filtered-refresh",
        enabled: true,
        refreshEnabled: true,
        refreshScope: "recent:all",
        refetch: recentRefetch,
      }),
    );

    expect(filtered.result.current).toBe(filteredItems);
    act(() => observeOwnHistoryRecordChange(userId, "idle-epic", 60_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(filteredRefetch).toHaveBeenCalledTimes(1);
    expect(recentRefetch).toHaveBeenCalledTimes(1);
    expect(filtered.result.current).toEqual([]);
    expect(filtered.result.current).not.toContainEqual(
      expect.objectContaining({ epicId: "idle-epic" }),
    );
    expect(unfiltered.result.current[0]?.recentAtMs).toBe(60_000);
    filtered.unmount();
    unfiltered.unmount();
  });
});
