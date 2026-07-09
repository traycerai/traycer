/**
 * Shared builders for opener sub-page leaves. Every opener item carries
 * group "open" + scope "actions" (rendered by the shell's OpenerRootView /
 * SubpageView, never the global buckets). Existing-item leaves route their
 * open through the canonical `openTileIntoTargetGroup` delegate so a fresh
 * instance lands in the bound target group (dedup intentionally bypassed).
 */
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * Cap on rows handed to the renderer for a large two-step list (Files / Diff).
 * The full tree (up to 25k entries) is path-filtered by the live palette query
 * first (see `matchesPathQuery`); only the top slice is rendered so the
 * sub-page never janks.
 */
export const OPENER_RESULT_CAP = 100;

/**
 * Non-actionable hint row appended when a large list was truncated, so the
 * user knows results are capped and to refine the query.
 */
export function openerTruncatedHint(
  categoryId: string,
  shown: number,
): CommandItem {
  return {
    id: `open:${categoryId}:truncated`,
    label: `Showing first ${shown} - type to filter`,
    description: null,
    keywords: [],
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => undefined,
  };
}

interface OpenerActionLeafArgs {
  readonly id: string;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly run: () => void;
}

/** A plain opener leaf that runs an action (e.g. "New chat", existing item). */
export function openerActionLeaf(args: OpenerActionLeafArgs): CommandItem {
  return {
    id: args.id,
    label: args.label,
    description: null,
    keywords: args.keywords,
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: args.run,
  };
}

interface OpenerSubpageLeafArgs {
  readonly id: string;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly subpage: CommandSubpage;
}

/** An opener leaf that pushes a nested sub-page (e.g. "New TUI" → harness). */
export function openerSubpageLeaf(args: OpenerSubpageLeafArgs): CommandItem {
  return {
    id: args.id,
    label: args.label,
    description: null,
    keywords: args.keywords,
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: args.subpage,
    run: () => undefined,
  };
}

/** Leaf for an already-existing tile ref: opens a fresh instance in target. */
export function openerExistingLeaf(
  categoryId: string,
  ctx: CommandContext,
  ref: EpicCanvasTileRef,
): CommandItem {
  return openerActionLeaf({
    // Row id is keyed on the stable content id (unique among a category's
    // existing items); the ref's instanceId is a placeholder re-minted by
    // openTileInPane on open.
    id: `open:${categoryId}:${ref.id}`,
    label: ref.name,
    keywords: [ref.name],
    run: () =>
      openTileIntoTargetGroup({
        tabId: ctx.activeTabId,
        groupId: ctx.targetGroupId,
        ref,
        navigateNestedFocus: ctx.router.navigateNestedFocus,
      }),
  });
}
