import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  type LucideIcon,
} from "lucide-react";
import type { WorktreeDisplayedPrState } from "@/components/worktree/worktree-pr-metadata-model";

/**
 * The single PR-state palette, shared by both surfaces that render one: the
 * hover card's tinted pill (`worktree-pr-metadata.tsx`) and the sidebar row's
 * icon-only variant (`worktree-pr-state-icons.tsx`).
 *
 * Shared rather than copied because the two DID drift. The icon variant was
 * written as "same validated tokens as the pill", then the pill's redesign
 * moved colour off the label and onto the glyph at `-600`/`-400` - a ramp
 * nothing re-checked, because the contrast matrix was still pointed at the
 * label that had just stopped being coloured. That left the pill's glyph at
 * 2.12:1 over its own tint on Tokyo Night light, under the 3:1 WCAG 1.4.11
 * floor for a graphic that carries meaning - and the glyph is now the ONLY
 * thing carrying PR state in the pill.
 */

/**
 * Distinct SHAPES, not just distinct colours: open / merged / closed stay
 * separable for a red-green colourblind reader, and they are the glyphs GitHub
 * trained everyone on, so the state is readable without a legend.
 */
export const PR_STATE_ICON: Record<WorktreeDisplayedPrState, LucideIcon> = {
  open: GitPullRequest,
  closed: GitPullRequestClosed,
  merged: GitMerge,
};

/**
 * `-800` light / `-300` dark. The light token is two steps darker than the
 * usual `-600` accent because the pill composites it over its OWN 10% state
 * tint, on presets whose light surfaces are already dark (Tokyo Night light,
 * Gruvbox light). `-700` reaches only 3.23:1 there; `-800` clears 4.5:1 on
 * every preset, so it satisfies the 3:1 graphic floor with margin and stays
 * valid if a variant ever puts these tokens back on text.
 *
 * Dropping the tint only ADDS contrast - it composites toward the glyph in
 * both variants - so the untinted sidebar variant is covered by the same
 * numbers. See `worktree-pr-metadata.test.tsx`'s per-preset matrix.
 */
export const PR_STATE_TINT_CLASS: Record<WorktreeDisplayedPrState, string> = {
  open: "text-green-800 dark:text-green-300",
  closed: "text-red-800 dark:text-red-300",
  merged: "text-purple-800 dark:text-purple-300",
};
