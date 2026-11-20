import { useMemo, useState } from "react";
import {
  flattenChatTreeRows,
  indexRowsByKey,
  sameRowKeySequence,
  stabilizeChatTreeRows,
  type ChatTreeRow,
  type ChatTreeRowModel,
  type FlattenChatTreeRowsInput,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";

interface HeldModel {
  /** The flatten the model was last built from. */
  readonly source: readonly ChatTreeRow[];
  readonly model: ChatTreeRowModel;
}

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
  const [held, setHeld] = useState<HeldModel>(() => ({
    source: fresh,
    model: {
      rows: fresh,
      revision: 0,
      indexByKey: indexRowsByKey(fresh),
    },
  }));
  // Derived from the previous render's model, so it is updated during render
  // (React re-runs this component at once, before committing anything). It is
  // stored only when the rows differ: an input rebuilt with the same content
  // on every render must not re-render this forever.
  if (held.source !== fresh) {
    const model = nextModel(held.model, fresh);
    if (model !== held.model) setHeld({ source: fresh, model });
    return model;
  }
  return held.model;
}
