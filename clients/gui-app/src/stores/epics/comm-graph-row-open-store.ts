/**
 * Which communication-graph detail rows are expanded.
 *
 * The detail panels list RAW events, and an agent's real message is often a
 * full report - the list is unreadable if every body renders at full height, so
 * a long body collapses to a clamped preview and expands on demand. That is the
 * same bargain chat strikes with a received A2A card, so this store is the same
 * shape as the chat open stores and shares their `updateOpenIds` helper: an
 * immutable id set whose no-op writes bail out by identity.
 *
 * KEYED BY `hostId:id`, not by list position. Row ids are monotonic per host
 * only, and the merged array is re-sorted as rows arrive, so a row can move
 * mid-list while it is open - an index-keyed set would hand its expansion to
 * whatever slid into that slot. Scoped per epic on top of that, because a host
 * serves many epics and its per-epic logs number their rows independently.
 *
 * SESSION-ONLY and deliberately not persisted, for the same reason as
 * `comm-graph-timeline-store`: this is a reading position into a log that is
 * itself not persisted client-side.
 */
import { create } from "zustand";
import { updateOpenIds } from "@/stores/chats/open-id-set";

const NO_OPEN_ROWS: ReadonlySet<string> = new Set<string>();

interface CommGraphRowOpenStore {
  readonly openRowKeysByEpicId: Readonly<
    Record<string, ReadonlySet<string> | undefined>
  >;
  readonly setRowOpen: (epicId: string, rowKey: string, open: boolean) => void;
}

export const useCommGraphRowOpenStore = create<CommGraphRowOpenStore>(
  (set) => ({
    openRowKeysByEpicId: {},

    setRowOpen: (epicId, rowKey, open) =>
      set((state) => {
        const current = state.openRowKeysByEpicId[epicId] ?? NO_OPEN_ROWS;
        const next = updateOpenIds(current, rowKey, open);
        if (next === current) return state;
        return {
          openRowKeysByEpicId: { ...state.openRowKeysByEpicId, [epicId]: next },
        };
      }),
  }),
);

/** The stable row identity used as the open key - see the module note. */
export function commGraphRowKey(hostId: string, id: number): string {
  return `${hostId}:${id}`;
}

export function useCommGraphRowOpen(epicId: string, rowKey: string): boolean {
  return useCommGraphRowOpenStore(
    (state) => state.openRowKeysByEpicId[epicId]?.has(rowKey) ?? false,
  );
}

export function useSetCommGraphRowOpen(): (
  epicId: string,
  rowKey: string,
  open: boolean,
) => void {
  return useCommGraphRowOpenStore((state) => state.setRowOpen);
}
