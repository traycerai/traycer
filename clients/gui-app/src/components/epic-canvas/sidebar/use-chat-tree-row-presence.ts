import { useCallback, useState } from "react";
import {
  indexRowsByKey,
  sameRowKeySequence,
  type ChatTreeRow,
  type ChatTreeRowModel,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";

/**
 * The chat tree's rows as the list draws them: the model's rows plus the rows
 * still fading out of it, each kept in the slot it left.
 *
 * The recursive tree drew every group of children inside an `AnimatePresence`,
 * which set the tree's motion rules, and these are those rules over the flat
 * list:
 *
 * - A row fades out where it stood when its group dropped it while the group
 *   stayed open, and its node is still in the task: a filter, the archive or a
 *   move to another parent took it away. A row leaving with its exiting parent
 *   fades with it. A row whose node is gone, whose parent collapsed, or that
 *   scrolled out of the window goes at once, as an unmounted group did.
 * - When the model changes, every row that moves slides to its new place: the
 *   panel re-rendered the root group, and every row moved with its root.
 * - When a fade ends, the rows of that row's own group slide into its slot and
 *   every other row is set down where it now belongs: only that group's
 *   `AnimatePresence` re-rendered.
 *
 * A row slides when its `motionStamp` changes in the same render that moves
 * it; see `ChatTreeVirtualList`.
 */
export interface ChatTreeRowPresence {
  readonly model: ChatTreeRowModel;
  /** The rows fading out, by key. */
  readonly departing: ReadonlyMap<string, ChatTreeRow>;
  readonly motionStamp: (row: ChatTreeRow) => number;
  /** Drops a fading row once its fade has ended, or when nothing draws it. */
  readonly completeExit: (key: string) => void;
}

interface PresenceState {
  /** The model the presented rows were last built from. */
  readonly source: ChatTreeRowModel;
  readonly model: ChatTreeRowModel;
  readonly departing: ReadonlyMap<string, ChatTreeRow>;
  readonly tick: number;
  /** The stamp every row carries at least: the last change that moved them all. */
  readonly allStamp: number;
  /** A group's own stamp, by its parent row's key, when it is newer. */
  readonly groupStamps: ReadonlyMap<string, number>;
}

function parentStaysOpen(next: ChatTreeRowModel, parentKey: string): boolean {
  const index = next.indexByKey.get(parentKey);
  if (index === undefined) return false;
  const parent = next.rows[index];
  return parent.expanded && parent.hasChildren;
}

/** The rows that fade out of `previous` on the way to `next`, in order. */
function departingRows(
  previous: PresenceState,
  next: ChatTreeRowModel,
  isRowGone: (row: ChatTreeRow) => boolean,
): Map<string, ChatTreeRow> {
  const departing = new Map<string, ChatTreeRow>();
  // Preorder, so a parent is decided before its children.
  for (const row of previous.model.rows) {
    if (next.indexByKey.has(row.key)) continue;
    if (previous.departing.has(row.key)) {
      departing.set(row.key, row);
      continue;
    }
    if (isRowGone(row)) continue;
    const { parentKey } = row;
    if (
      parentKey === null ||
      departing.has(parentKey) ||
      parentStaysOpen(next, parentKey)
    ) {
      departing.set(row.key, row);
    }
  }
  return departing;
}

/** `next`'s rows with each departing row kept after the row it followed. */
function presentRows(
  previous: readonly ChatTreeRow[],
  departing: ReadonlyMap<string, ChatTreeRow>,
  next: ChatTreeRowModel,
): readonly ChatTreeRow[] {
  if (departing.size === 0) return next.rows;
  const after = new Map<string | null, ChatTreeRow[]>();
  let anchor: string | null = null;
  for (const row of previous) {
    if (departing.has(row.key)) {
      const held = after.get(anchor);
      if (held === undefined) after.set(anchor, [row]);
      else held.push(row);
    } else if (next.indexByKey.has(row.key)) {
      anchor = row.key;
    }
  }
  const rows: ChatTreeRow[] = [...(after.get(null) ?? [])];
  for (const row of next.rows) {
    rows.push(row);
    const held = after.get(row.key);
    if (held !== undefined) rows.push(...held);
  }
  return rows;
}

function modelOf(
  rows: readonly ChatTreeRow[],
  previous: ChatTreeRowModel,
  source: ChatTreeRowModel,
): ChatTreeRowModel {
  if (sameRowKeySequence(previous.rows, rows)) {
    return rows === previous.rows ? previous : { ...previous, rows };
  }
  return {
    rows,
    revision: previous.revision + 1,
    indexByKey: rows === source.rows ? source.indexByKey : indexRowsByKey(rows),
  };
}

function initialState(model: ChatTreeRowModel): PresenceState {
  return {
    source: model,
    model,
    departing: new Map(),
    tick: 0,
    allStamp: 0,
    groupStamps: new Map(),
  };
}

function follow(
  previous: PresenceState,
  source: ChatTreeRowModel,
  isRowGone: (row: ChatTreeRow) => boolean,
  exitEnabled: boolean,
): PresenceState {
  const departing = exitEnabled
    ? departingRows(previous, source, isRowGone)
    : new Map<string, ChatTreeRow>();
  const rows = presentRows(previous.model.rows, departing, source);
  const model = modelOf(rows, previous.model, source);
  if (model.revision === previous.model.revision) {
    return { ...previous, source, model, departing };
  }
  const tick = previous.tick + 1;
  return {
    source,
    model,
    departing,
    tick,
    allStamp: tick,
    groupStamps: new Map(),
  };
}

function withoutDeparted(previous: PresenceState, key: string): PresenceState {
  const row = previous.departing.get(key);
  if (row === undefined) return previous;
  const departing = new Map(previous.departing);
  departing.delete(key);
  const rows = previous.model.rows.filter((entry) => entry.key !== key);
  const tick = previous.tick + 1;
  const groupStamps = new Map(previous.groupStamps);
  if (row.parentKey !== null) groupStamps.set(row.parentKey, tick);
  return {
    source: previous.source,
    model: {
      rows,
      revision: previous.model.revision + 1,
      indexByKey: indexRowsByKey(rows),
    },
    departing,
    tick,
    allStamp: row.parentKey === null ? tick : previous.allStamp,
    groupStamps: row.parentKey === null ? new Map() : groupStamps,
  };
}

export function useChatTreeRowPresence(
  source: ChatTreeRowModel,
  isRowGone: (row: ChatTreeRow) => boolean,
  exitEnabled: boolean,
): ChatTreeRowPresence {
  const [state, setState] = useState(() => initialState(source));
  // Derived from the previous render's rows, so it is updated during render
  // (React re-runs this component at once, before committing anything).
  let current = state;
  if (state.source !== source) {
    current = follow(state, source, isRowGone, exitEnabled);
    setState(current);
  }
  const completeExit = useCallback((key: string) => {
    setState((previous) => withoutDeparted(previous, key));
  }, []);
  const { allStamp, groupStamps } = current;
  const motionStamp = useCallback(
    (row: ChatTreeRow): number => {
      let stamp = allStamp;
      for (const [parentKey, groupStamp] of groupStamps) {
        if (groupStamp > stamp && row.key.startsWith(`${parentKey}/`)) {
          stamp = groupStamp;
        }
      }
      return stamp;
    },
    [allStamp, groupStamps],
  );
  return {
    model: current.model,
    departing: current.departing,
    motionStamp,
    completeExit,
  };
}
