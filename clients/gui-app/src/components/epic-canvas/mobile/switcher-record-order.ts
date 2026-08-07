import { useMemo } from "react";
import { useEpicTreeIndex, type EpicTreeRecord } from "@/lib/epic-selectors";
import {
  DEFAULT_SORT_MODE,
  makeNodeComparator,
  sortNodeIds,
} from "@/lib/epic-sort";

/**
 * Orders a flat record slice most-recently-updated first, resolving timestamps
 * through the tree index. `useEpicArtifactRecords()` yields records grouped by
 * source (all chats, then all TUI agents, then all artifacts); the switcher
 * lists want a single interleaved list, so we sort by the desktop default mode
 * (last updated, descending) via the shared `epic-sort` comparator rather than
 * inventing a parallel ordering.
 */
export function useOrderedSwitcherRecords(
  records: ReadonlyArray<EpicTreeRecord>,
): ReadonlyArray<EpicTreeRecord> {
  const nodeById = useEpicTreeIndex().nodeById;
  return useMemo(() => {
    if (records.length < 2) return records;
    const orderedIds = sortNodeIds(
      records.map((record) => record.id),
      nodeById,
      makeNodeComparator(DEFAULT_SORT_MODE),
    );
    const recordById = new Map(records.map((record) => [record.id, record]));
    return orderedIds.flatMap((id) => {
      const record = recordById.get(id);
      return record === undefined ? [] : [record];
    });
  }, [records, nodeById]);
}
