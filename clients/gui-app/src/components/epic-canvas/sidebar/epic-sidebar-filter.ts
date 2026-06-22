/**
 * Tree-wide filter plumbing shared by the chat and artifact sidebar panels.
 *
 * A filter is applied as a precomputed *visible-id set* rather than threaded as
 * a prop through the recursive node components. The panel body computes the set
 * once (matches plus their ancestors, so a deep match stays reachable) and
 * publishes it through {@link SidebarFilterVisibilityContext}. Both the
 * root-id and child-id hooks intersect against it, so every tree level filters
 * consistently with zero changes to the node render path.
 *
 * A `null` value means "no active filter" - render everything.
 */
import { createContext, use, useMemo } from "react";
import { useChildIds, useEpicTreeIndex } from "@/lib/epic-selectors";
import type { TreeNode } from "@/stores/epics/open-epic/types";
import { sortNodeIds, type NodeComparator } from "@/lib/epic-sort";

type PanelTreeFilter = (type: string | null | undefined) => boolean;

export const SidebarFilterVisibilityContext =
  createContext<ReadonlySet<string> | null>(null);

export function useSidebarVisibleIds(): ReadonlySet<string> | null {
  return use(SidebarFilterVisibilityContext);
}

/**
 * Active sort comparator for the panel, or `null` for the projector's
 * default order. The panel body computes it once from the panel's sort
 * mode and publishes it here so root and child levels reorder identically -
 * the sort analogue of {@link SidebarFilterVisibilityContext}.
 */
export const SidebarSortContext = createContext<NodeComparator | null>(null);

function useSidebarComparator(): NodeComparator | null {
  return use(SidebarSortContext);
}

/**
 * Restrict a list of ids to the active visible set, or pass it through
 * unchanged when no filter is active (`visibleIds === null`). Identity is
 * preserved in the pass-through case so memoized callers don't churn.
 */
export function applyVisibleFilter(
  ids: readonly string[],
  visibleIds: ReadonlySet<string> | null,
): readonly string[] {
  return visibleIds === null ? ids : ids.filter((id) => visibleIds.has(id));
}

/**
 * Union the always-expanded ancestor set with the filter's visible ids so a
 * filtered subtree opens to reveal its matches. Returns the ancestor set
 * unchanged (same identity) when no filter is active.
 */
export function mergeForcedExpanded(
  ancestorIds: ReadonlySet<string>,
  visibleIds: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (visibleIds === null) return ancestorIds;
  const merged = new Set(ancestorIds);
  for (const id of visibleIds) merged.add(id);
  return merged;
}

/**
 * Child ids of `parentId` that survive both the panel's structural
 * `treeFilter` (chat vs artifact node kinds) and the active visibility filter.
 * Shared by both panel trees so the filtering rule lives in one place.
 */
export function useFilteredPanelChildIds(
  parentId: string,
  treeFilter: PanelTreeFilter,
): readonly string[] {
  const tree = useEpicTreeIndex();
  const childIds = useChildIds(parentId);
  const visibleIds = useSidebarVisibleIds();
  const comparator = useSidebarComparator();
  return useMemo(() => {
    if (childIds.length === 0) return childIds;
    const filtered = childIds.filter((childId) => {
      if (!Object.hasOwn(tree.nodeById, childId)) return false;
      if (!treeFilter(tree.nodeById[childId].type)) return false;
      if (visibleIds !== null && !visibleIds.has(childId)) return false;
      return true;
    });
    // `childIds` arrive in projector (default) order; re-sort only when the
    // panel has a non-default mode (`comparator !== null`).
    return sortNodeIds(filtered, tree.nodeById, comparator);
  }, [childIds, tree, treeFilter, visibleIds, comparator]);
}

/**
 * Whether the filtered tree should show its "no matches" row: a filter is
 * active (`visibleIds !== null`) yet nothing - no root node and no pending
 * create row - survives to render. Shared so the rule can't drift between the
 * chat and artifact panels.
 */
export function isFilteredTreeEmpty(args: {
  readonly visibleIds: ReadonlySet<string> | null;
  readonly rootIds: readonly string[];
  readonly localRootPending: object | null;
  readonly acknowledgedRootPending: object | null;
  readonly preAckRootCreates: readonly unknown[];
  readonly visiblePendingRootCreates: readonly unknown[];
}): boolean {
  return (
    args.visibleIds !== null &&
    args.rootIds.length === 0 &&
    args.localRootPending === null &&
    args.acknowledgedRootPending === null &&
    args.preAckRootCreates.length === 0 &&
    args.visiblePendingRootCreates.length === 0
  );
}

/**
 * Expand a set of matched node ids to also include every ancestor along each
 * match's parent chain, so the matches remain reachable in the rendered tree.
 * The parent walk is guarded against cycles via the running `result` set.
 */
export function collectWithAncestors(
  matchIds: readonly string[],
  nodeById: Readonly<Record<string, TreeNode>>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const matchId of matchIds) {
    let current: string | null = matchId;
    while (current !== null && !result.has(current)) {
      result.add(current);
      if (!Object.hasOwn(nodeById, current)) break;
      current = nodeById[current].parentId;
    }
  }
  return result;
}
