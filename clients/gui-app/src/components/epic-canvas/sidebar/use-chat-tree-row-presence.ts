import { useCallback, useLayoutEffect, useReducer, useRef } from "react";
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
 * The recursive tree drew the root rows, and every group of a local row's
 * children, inside an `AnimatePresence`, which set the tree's motion rules;
 * these are those rules over the flat list:
 *
 * - A row fades out where it stood when its group dropped it while the group
 *   stayed open, and its node is still in the task: a filter, the archive or a
 *   move to another parent took it away. A row leaving with its exiting parent
 *   fades with it. A row whose node is gone, whose parent collapsed, or that
 *   scrolled out of the window goes at once, as an unmounted group did.
 * - A cloud row's children (an orchestrator's subagents) were drawn without an
 *   `AnimatePresence`, so a subagent leaving an open orchestrator goes at once.
 * - When the model changes, every row that moves slides to its new place: the
 *   panel re-rendered the root group, and every row moved with its root.
 * - When a fade ends, the rows of that row's own group slide into its slot and
 *   every other row is set down where it now belongs: only that group's
 *   `AnimatePresence` re-rendered.
 *
 * A row slides when its `motionStamp` changes in the same render that moves
 * it; see `ChatTreeVirtualList`.
 */
interface ChatTreeRowPresence {
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
      (row.kind !== "cloud" && parentStaysOpen(next, parentKey))
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

/**
 * The presence a render draws: the last committed presence carried on to
 * `source`. It reads only committed state, so a render React throws away
 * changes nothing, and a render run twice derives the same presence.
 */
function derivePresence(
  committed: PresenceState | null,
  source: ChatTreeRowModel,
  isRowGone: (row: ChatTreeRow) => boolean,
  exitEnabled: boolean,
): PresenceState {
  if (committed === null) return initialState(source);
  if (committed.source === source) return committed;
  return follow(committed, source, isRowGone, exitEnabled);
}

export function useChatTreeRowPresence(
  source: ChatTreeRowModel,
  isRowGone: (row: ChatTreeRow) => boolean,
  exitEnabled: boolean,
): ChatTreeRowPresence {
  // The last committed presence. Written only in the layout effect below and
  // by `completeExit`, which runs outside render; read here to derive.
  const committedRef = useRef<PresenceState | null>(null);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const base = committedRef.current;
  const state = derivePresence(base, source, isRowGone, exitEnabled);
  useLayoutEffect(() => {
    // A fade that ended after this render began wins: the re-render it asked
    // for derives from it.
    if (committedRef.current === base) committedRef.current = state;
  }, [base, state]);
  const completeExit = useCallback((key: string) => {
    const committed = committedRef.current;
    if (committed === null) return;
    const next = withoutDeparted(committed, key);
    if (next === committed) return;
    committedRef.current = next;
    rerender();
  }, []);
  const { allStamp, groupStamps } = state;
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
    model: state.model,
    departing: state.departing,
    motionStamp,
    completeExit,
  };
}
