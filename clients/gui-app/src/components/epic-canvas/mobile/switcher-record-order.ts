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
