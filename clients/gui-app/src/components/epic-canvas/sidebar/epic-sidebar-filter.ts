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
import { createContext, use } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChildIds } from "@/lib/epic-selectors";
import { useEpicStore } from "@/hooks/use-epic-store";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
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
 *
 * ## Subscribed to the ANSWER, not to the tree
 *
 * This runs once per ROW in both panels, so what it subscribes to is what every
 * row subscribes to. It used to read `useEpicTreeIndex()` - the whole `tree`
 * slice - and derive from it in a `useMemo`. That re-rendered every row
 * whenever the slice's identity moved, and the slice moves on any record
 * change: `TreeNode` carries `updatedAt`, and the host stamps it on every body
 * write batch, so a burst of typing in one artifact re-rendered all forty rows
 * at ~4 Hz.
 *
 * `memo` on the row could never have stopped that. It guards against a
 * re-render propagated from a parent with equal props; a store subscription
 * inside the component is an independent trigger. The fix has to be here, at
 * what the row subscribes to.
 *
 * So the derivation moved INSIDE the selector and the result is compared
 * shallowly: a row re-renders only when its own answer changes. The identity
 * pass-through for a childless parent is kept and matters more than before -
 * it is what makes a leaf row, which is most of them, compare equal for free.
 *
 * The cost is that the filter and sort now run per notification rather than per
 * change, which the file next door names as the trade
 * (`epic-selectors.ts`: "`useShallow` bails the subscriber's re-render but not
 * the recompute"). That is the right side of it here: the work is a filter over
 * one row's children, and what it buys is not re-rendering a whole subtree.
 */
export function useFilteredPanelChildIds(
  parentId: string,
  treeFilter: PanelTreeFilter,
): readonly string[] {
  const childIds = useChildIds(parentId);
  const visibleIds = useSidebarVisibleIds();
  const comparator = useSidebarComparator();
  return useEpicStore(
    useShallow((state: OpenEpicState): readonly string[] => {
      // Same identity out as in, so a childless row - the common case, and
      // every leaf - is shallow-equal to its previous answer by reference.
      if (childIds.length === 0) return childIds;
      const nodeById = state.tree.nodeById;
      const filtered = childIds.filter((childId) => {
        if (!Object.hasOwn(nodeById, childId)) return false;
        if (!treeFilter(nodeById[childId].type)) return false;
        if (visibleIds !== null && !visibleIds.has(childId)) return false;
        return true;
      });
      // `childIds` arrive in projector (default) order; re-sort only when the
      // panel has a non-default mode (`comparator !== null`).
      //
      // A recency comparator reads `updatedAt`, so under one a stamp CAN
      // legitimately reorder siblings and the rows that moved do re-render.
      // That is the sort doing its job, not churn, and it is why the pin for
      // this asserts under the default order.
      return sortNodeIds(filtered, nodeById, comparator);
    }),
  );
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
 * A bare printable character with no modifier - the type-to-filter trigger
 * shared by the artifact and chat panels.
 *
 * Excludes space so it can keep its tree-row activation meaning, and anything
 * carrying a modifier so shortcuts still reach their handlers.
 */
export function isTypeToFilterKey(event: globalThis.KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 && event.key !== " ";
}

/**
 * Whether a type-to-filter keystroke originated inside something the user is
 * editing - a rename input, a composer - where the character belongs to that
 * field and must not be stolen to open search.
 */
export function isTypeToFilterEditableTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, [contenteditable='true']") !== null;
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
