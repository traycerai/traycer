import { useMemo, useState } from "react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { buildHistoryItemsFromTasks } from "@/components/home/data/home-page.data";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useTurnEpicIds } from "@/stores/use-working-epic-ids";

const EMPTY_EPIC_IDS: readonly string[] = [];
const EMPTY_ITEMS: readonly HistoryItem[] = [];

export interface UseInProgressHistoryItemsParams {
  /** The feed these rows are being lifted out of, in its own order. */
  readonly items: readonly HistoryItem[];
  /**
   * The WIDENED identity `useHistoryQuery` scoped `items` to, not an
   * authorization - the backfill below gates its cloud spend separately, the
   * way every other `epic.getTaskContexts` caller does.
   */
  readonly userId: string | null;
  /**
   * False keeps this hook inert: no store read reaches a render, no id list is
   * built and the backfill query stays disabled. Every desktop surface and
   * every narrowed History passes `false`.
   */
  readonly enabled: boolean;
}

/**
 * The rows for the tasks an agent is replying in right now, newest first. A
 * task whose only activity is a background shell or monitor is not lifted.
 *
 * The phone's cheap counterpart to `useCurrentTasks`, which is what Home uses
 * to build the same group on desktop. That hook cannot be mounted here: the
 * drawer is mounted for the whole life of the mobile shell, and `useCurrentTasks`
 * opens a pin-boundary scan that walks up to `PIN_TAIL_PAGE_CAP` further cloud
 * list pages, plus an open-tab local-rows probe - all of it to complete the
 * `pinned` and `open` groups, which neither phone surface renders.
 *
 * What is left is the two things the `inProgress` group actually needs:
 *
 *  1. {@link useTurnEpicIds} - a `useSyncExternalStore` read over the
 *     agent-activity store and the warm chat/epic registries. Already
 *     populated, no request of its own.
 *  2. The rows. Most come from the feed the caller already fetched; the
 *     running epic that sits past the loaded page is resolved by id through
 *     `epic.getTaskContexts` - one batch, cached for five minutes, and not
 *     issued at all when the page already carries every working epic.
 *
 * A backfilled row carries no worktree metadata (branch / PR), the same as
 * desktop's `CurrentTasksSection` rows, which are built from this identical
 * source - the feed's enrichment is a property of the list query, not of the
 * task.
 */
export function useInProgressHistoryItems(
  params: UseInProgressHistoryItemsParams,
): readonly HistoryItem[] {
  // Fixed at mount, matching `useCurrentTasks`: `updatedLabel` and
  // `updatedBucket` are rendered strings, and a fresh `Date.now()` per render
  // would rebuild every row to say the same thing.
  const [nowMs] = useState(() => Date.now());
  const workingEpicIds = useTurnEpicIds();
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const listed = useMemo(
    () =>
      params.enabled
        ? params.items.filter((item) => workingEpicIds.has(item.epicId))
        : EMPTY_ITEMS,
    [params.enabled, params.items, workingEpicIds],
  );
  const missingEpicIds = useMemo(() => {
    if (!params.enabled) return EMPTY_EPIC_IDS;
    const onPage = new Set(params.items.map((item) => item.epicId));
    return [...workingEpicIds].filter((epicId) => !onPage.has(epicId)).sort();
  }, [params.enabled, params.items, workingEpicIds]);
  const backfill = useEpicGetTaskContexts(missingEpicIds, params.userId, {
    enabled: cloudAuthorized,
  });
  const backfilled = useMemo(
    () =>
      buildHistoryItemsFromTasks(
        [...backfill.tasksById.values()],
        nowMs,
        params.userId,
        backfill.localHomedTaskIds,
      )
        // The batch is cached by id, so a task that has since gone idle can
        // still answer from it. Membership is decided by the store, never by
        // what the cache happens to hold.
        .filter((item) => workingEpicIds.has(item.epicId)),
    [
      backfill.localHomedTaskIds,
      backfill.tasksById,
      nowMs,
      params.userId,
      workingEpicIds,
    ],
  );
  return useMemo(() => {
    if (listed.length === 0 && backfilled.length === 0) return EMPTY_ITEMS;
    // Feed rows win over backfilled ones for the same epic: they carry the
    // list query's enrichment, and the backfill only exists to cover the epics
    // the feed never listed.
    const byEpicId = new Map<string, HistoryItem>();
    for (const item of [...listed, ...backfilled]) {
      if (!byEpicId.has(item.epicId)) byEpicId.set(item.epicId, item);
    }
    return [...byEpicId.values()].sort(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    );
  }, [backfilled, listed]);
}
