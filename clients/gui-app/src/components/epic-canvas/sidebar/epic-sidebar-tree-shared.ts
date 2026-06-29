/**
 * Shared tree utilities and constants for chat-tree and artifact-tree.
 * Extracted from the original monolithic epic-sidebar.tsx to eliminate duplication.
 */

import type { EpicNodeKind } from "@/lib/artifacts/node-display";

export const INDENT_PX = 16;
export const BASE_PAD_LEFT = 8;

/**
 * Horizontal offset (from a row's own padding-left edge) to the center of its
 * chevron/icon column. Indent guide rails are drawn at the parent depth plus
 * this offset so each rail sits under the column it descends from.
 */
export const TREE_GUIDE_OFFSET_PX = 7;

export const EMPTY_PENDING_LIST: ReadonlyArray<{ id: string; name: string }> =
  [];
export const EMPTY_PRE_ACK_LIST: ReadonlyArray<{
  tempId: string;
  name: string;
}> = [];

/**
 * Reveal-on-hover styling for panel section header action buttons (filter,
 * selection, collapse-all). Hidden until the `group/panel-section` is hovered
 * or a child is focused, so the header stays quiet at rest. The filter trigger
 * layers its own active-state override so an applied filter remains visible.
 *
 * Disabled shadcn buttons carry `disabled:opacity-50`, which would otherwise
 * pin these controls visible at rest because the pseudo-class outranks the base
 * `opacity-0`. The disabled overrides keep them hidden until the section is
 * revealed, then show them dimmed to signal that they are unavailable.
 */
export const PANEL_HEADER_ACTION_REVEAL_CLASS =
  "opacity-0 transition-opacity disabled:opacity-0 focus-visible:opacity-100 group-hover/panel-section:opacity-100 group-focus-within/panel-section:opacity-100 disabled:group-hover/panel-section:opacity-50 disabled:group-focus-within/panel-section:opacity-50";

/**
 * Reveal-on-hover styling for a tree row's inline "+" add control. Hidden at
 * rest, shown when the `group/tree-item` row is hovered / focused or the menu
 * is open - mirroring the "⋯" more-menu trigger beside it.
 *
 * The `disabled:*` overrides are load-bearing: shadcn `Button`'s base
 * `disabled:opacity-50` is a `:disabled` pseudo-class (specificity 0,2,0) and
 * outweighs the plain `opacity-0` rest rule (0,1,0), which would otherwise pin
 * a *disabled* control visible at 50% even when the row is not hovered.
 * `disabled:opacity-0` restores hidden-at-rest (tailwind-merge keeps it over
 * the base rule), and `disabled:group-hover/tree-item:opacity-50` keeps the
 * control dimmed once the row reveals it, signalling it is non-interactive.
 *
 * While a child create is pending the control instead stays pinned visible (at
 * the base 50% dim) so its inline spinner reads as progress regardless of hover.
 */
export function rowAddControlRevealClass(addChildIsPending: boolean): string {
  if (addChildIsPending) return "transition-opacity disabled:opacity-50";
  return "opacity-0 transition-opacity disabled:opacity-0 focus-visible:opacity-100 group-hover/tree-item:opacity-100 aria-expanded:opacity-100 disabled:group-hover/tree-item:opacity-50";
}

export const STATUS_DOT_CLASSES: Record<number, string> = {
  0: "bg-slate-400",
  1: "bg-amber-500",
  2: "bg-emerald-500",
};

export const STATUS_LABELS: Record<number, string> = {
  0: "Todo",
  1: "In Progress",
  2: "Done",
};

export function computeArtifactNodeStatusDot(
  artifactType: EpicNodeKind,
  statusValue: number | null,
): boolean {
  if (statusValue === null) return false;
  return artifactType === "ticket" || artifactType === "story";
}

export function computeArtifactNodeAddChildPending(args: {
  pendingChildName: string | null;
  pendingChildRealId: string | null;
  createArtifactPending: boolean;
}): boolean {
  return (
    args.pendingChildName !== null ||
    args.pendingChildRealId !== null ||
    args.createArtifactPending
  );
}

export function anyMutationPending(values: ReadonlyArray<boolean>): boolean {
  return values.some(Boolean);
}

export function nodePadRightClass(canEdit: boolean, showAdd: boolean): string {
  if (!canEdit) return "pr-2";
  if (showAdd) {
    return "pr-2 group-hover/tree-item:pr-14 group-focus-within/tree-item:pr-14 group-has-[[data-state=open]]/tree-item:pr-14";
  }
  return "pr-2 group-hover/tree-item:pr-8 group-focus-within/tree-item:pr-8 group-has-[[data-state=open]]/tree-item:pr-8";
}
