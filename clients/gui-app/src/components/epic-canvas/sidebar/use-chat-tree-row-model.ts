import { useLayoutEffect, useMemo, useRef } from "react";
import {
  flattenChatTreeRows,
  indexRowsByKey,
  sameRowKeySequence,
  stabilizeChatTreeRows,
  type ChatTreeRow,
  type ChatTreeRowModel,
  type FlattenChatTreeRowsInput,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";

function nextModel(
  previous: ChatTreeRowModel,
  fresh: readonly ChatTreeRow[],
): ChatTreeRowModel {
  const rows = stabilizeChatTreeRows(previous.rows, fresh);
  if (rows === previous.rows) return previous;
  if (sameRowKeySequence(previous.rows, rows)) {
    return { ...previous, rows };
  }
  return {
    rows,
    revision: previous.revision + 1,
    indexByKey: indexRowsByKey(rows),
  };
}

/**
 * The chat tree's row model for the panel: {@link flattenChatTreeRows} over the
 * panel's current inputs, with each unchanged row kept as the same object and
 * the revision moved only when the row sequence changes.
 */
export function useChatTreeRowModel(
  input: FlattenChatTreeRowsInput,
): ChatTreeRowModel {
  const {
    listEntries,
    pendingRoots,
    tree,
    expandedIds,
    visibleIds,
    treeFilter,
    comparator,
    clock,
  } = input;
  const fresh = useMemo(
    () =>
      flattenChatTreeRows({
        listEntries,
        pendingRoots,
        tree,
        expandedIds,
        visibleIds,
        treeFilter,
        comparator,
        clock,
      }),
    [
      listEntries,
      pendingRoots,
      tree,
      expandedIds,
      visibleIds,
      treeFilter,
      comparator,
      clock,
    ],
  );
  // The last COMMITTED model, written only in the layout effect below. Each
  // model is built from it and the flatten alone, so a render React throws
  // away never changes what a committed render returns.
  const committed = useRef<ChatTreeRowModel | null>(null);
  const model = useMemo(
    () =>
      committed.current === null
        ? { rows: fresh, revision: 0, indexByKey: indexRowsByKey(fresh) }
        : nextModel(committed.current, fresh),
    [fresh],
  );
  useLayoutEffect(() => {
    committed.current = model;
  }, [model]);
  return model;
}
