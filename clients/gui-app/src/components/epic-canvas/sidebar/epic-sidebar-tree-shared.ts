/**
 * Shared tree utilities and constants for chat-tree and artifact-tree.
 * Extracted from the original monolithic epic-sidebar.tsx to eliminate duplication.
 */

import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";

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

/**
 * Per-type icon color customization for a sidebar row's leading glyph, read
 * here rather than threaded from the tree root so the leading icon stays a
 * leaf concern. `ChatProgressIcon` already subscribes to exactly these two
 * settings internally for chat rows; every OTHER sidebar row glyph (terminal
 * agents, cloud rows, static node icons) mirrors it through this hook so one
 * row kind cannot drift muted while another picks up "color by type" in the
 * same column - a chat glyph's tint must depend on the user's icon-color
 * setting, never on which list the row arrived from.
 */
export function useNodeIconDisplay(artifactType: EpicNodeKind): {
  readonly className: string;
  readonly style: { color: string | undefined } | undefined;
} {
  const colorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const color = useSettingsStore((s) => s.artifactIconColors[artifactType]);
  return {
    className: cn(
      "size-3.5 shrink-0",
      colorMode === "none" && "text-muted-foreground/70",
    ),
    style: colorMode === "byType" ? { color } : undefined,
  };
}

/**
 * Right padding a row reserves for its hover-revealed controls.
 *
 * `revealed` is for a surface whose controls never wait for hover (touch has no
 * hover to wait for): the row must then hold the wider pad at rest, because the
 * controls are already sitting in it. A `pointer-coarse:` variant would say the
 * same thing less reliably - it would have to out-order the `group-hover`
 * rules rather than replace them - so the branch is taken here, in the one
 * place the string is built.
 */
export function nodePadRightClass(
  canEdit: boolean,
  showAdd: boolean,
  revealed: boolean,
): string {
  if (!canEdit) return "pr-2";
  if (showAdd) {
    if (revealed) return "pr-14";
    return "pr-2 group-hover/tree-item:pr-14 group-focus-within/tree-item:pr-14 group-has-[[data-state=open]]/tree-item:pr-14";
  }
  if (revealed) return "pr-8";
  return "pr-2 group-hover/tree-item:pr-8 group-focus-within/tree-item:pr-8 group-has-[[data-state=open]]/tree-item:pr-8";
}
