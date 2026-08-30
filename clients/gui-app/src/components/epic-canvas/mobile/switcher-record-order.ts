import { useMemo } from "react";
import { useEpicTreeIndex, type EpicTreeRecord } from "@/lib/epic-selectors";
import {
  makeNodeComparator,
  sortNodeIds,
  type SortMode,
} from "@/lib/epic-sort";

/**
 * Orders a flat record slice by `sort`, resolving timestamps through the tree
 * index. `useEpicArtifactRecords()` yields records grouped by source (all
 * chats, then all TUI agents, then all artifacts); the switcher lists want a
 * single interleaved list, so they sort through the shared `epic-sort`
 * comparator rather than inventing a parallel ordering.
 *
 * The comparator is built unconditionally, including for the default mode. The
 * sidebar's own `sortNodeIds` calls pass `null` there because their input
 * already arrives in the projector's canonical order and needs no re-sort; a
 * grouped slice is not in that order, so skipping the default would leave every
 * TUI agent below every GUI chat no matter when either last moved.
 */
export function useOrderedSwitcherRecords(
  records: ReadonlyArray<EpicTreeRecord>,
  sort: SortMode,
): ReadonlyArray<EpicTreeRecord> {
  const nodeById = useEpicTreeIndex().nodeById;
  return useMemo(() => {
    if (records.length < 2) return records;
    const orderedIds = sortNodeIds(
      records.map((record) => record.id),
      nodeById,
      makeNodeComparator(sort),
    );
    const recordById = new Map(records.map((record) => [record.id, record]));
    return orderedIds.flatMap((id) => {
      const record = recordById.get(id);
      return record === undefined ? [] : [record];
    });
  }, [records, nodeById, sort]);
}

/**
 * The rows a switcher category renders: `records` narrowed to `matchIds`, then
 * ordered by `sort`. `null` match ids mean no filter is active and the slice
 * passes through with its identity intact.
 *
 * Narrowing is a plain membership test, with no ancestor expansion, because
 * these lists are flat: there is no parent row whose reachability a match
 * depends on. The sidebar's tree expands its matches for exactly that reason
 * and this surface has no equivalent debt.
 */
export function useNarrowedSwitcherRecords(
  records: ReadonlyArray<EpicTreeRecord>,
  matchIds: ReadonlySet<string> | null,
  sort: SortMode,
): ReadonlyArray<EpicTreeRecord> {
  const narrowed = useMemo(
    () =>
      matchIds === null
        ? records
        : records.filter((record) => matchIds.has(record.id)),
    [records, matchIds],
  );
  return useOrderedSwitcherRecords(narrowed, sort);
}
