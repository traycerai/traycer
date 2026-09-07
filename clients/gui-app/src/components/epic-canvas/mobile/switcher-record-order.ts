import { useMemo } from "react";
import { useEpicTreeIndex, type EpicTreeRecord } from "@/lib/epic-selectors";
import {
  makeNodeComparator,
  sortNodeIds,
  type SortMode,
} from "@/lib/epic-sort";

/**
 * `useEpicArtifactRecords()` yields records grouped by source (all chats, then all TUI agents, then all artifacts); the switcher lists want a single interleaved list, so they sort through the shared `epic-sort` comparator rather than inventing a parallel ordering.
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
 * The sidebar's tree expands its matches because a row there is unreachable until every ancestor above it is drawn and expanded; nothing on this surface is reachable only through a parent.
 * The Artifacts category draws nesting (`buildSwitcherArtifactTree`) but derives each depth from the records that SURVIVED this narrowing, so a match whose parent it removed is promoted to a root rather than hidden under one.
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
