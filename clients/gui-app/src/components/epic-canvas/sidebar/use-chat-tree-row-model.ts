import { useLayoutEffect, useMemo, useState } from "react";
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

interface RowModelCache {
  readonly modelFor: (fresh: readonly ChatTreeRow[]) => ChatTreeRowModel;
  readonly commit: (model: ChatTreeRowModel) => void;
}

/**
 * Every model is built from the last COMMITTED model and the current flatten
 * alone, so a render React throws away (a StrictMode re-run, an interrupted
 * concurrent render) never changes what a committed render returns. A row
 * object is reused only where its values equal the committed row of the same
 * key, and the revision moves only when the key sequence differs from the
 * committed one. The same flatten gets the same model, so a render run twice
 * reads one model.
 */
function createRowModelCache(): RowModelCache {
  let committed: ChatTreeRowModel | null = null;
  let source: readonly ChatTreeRow[] | null = null;
  let built: ChatTreeRowModel | null = null;
  return {
    modelFor: (fresh) => {
      if (fresh === source && built !== null) return built;
      built =
        committed === null
          ? { rows: fresh, revision: 0, indexByKey: indexRowsByKey(fresh) }
          : nextModel(committed, fresh);
      source = fresh;
      return built;
    },
    commit: (model) => {
      committed = model;
    },
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
  const [cache] = useState(createRowModelCache);
  const model = cache.modelFor(fresh);
  useLayoutEffect(() => {
    cache.commit(model);
  }, [cache, model]);
  return model;
}
