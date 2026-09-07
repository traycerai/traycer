import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  type LucideIcon,
} from "lucide-react";
import type { WorktreeDisplayedPrState } from "@/components/worktree/worktree-pr-metadata-model";

/** Shared rather than copied because the two did drift. */

export const PR_STATE_ICON: Record<WorktreeDisplayedPrState, LucideIcon> = {
  open: GitPullRequest,
  closed: GitPullRequestClosed,
  merged: GitMerge,
};

/** `-700` reaches only 3.23:1 there; `-800` clears 4.5:1 on every preset, so it satisfies the 3:1 graphic floor
 * with margin and stays valid if a variant ever puts these tokens back on text. */
export const PR_STATE_TINT_CLASS: Record<WorktreeDisplayedPrState, string> = {
  open: "text-green-800 dark:text-green-300",
  closed: "text-red-800 dark:text-red-300",
  merged: "text-purple-800 dark:text-purple-300",
};

/** Shared by the chat/owner hover card (`worktree-pr-metadata.tsx`) and the Epic PR panel row, which renders
 * the same "PR number + state" idea and must not grow a second dialect of it. */
export const PR_STATE_PILL_CLASS: Record<WorktreeDisplayedPrState, string> = {
  open: "border-transparent bg-green-500/10 text-foreground hover:bg-green-500/20",
  closed:
    "border-transparent bg-red-500/10 text-foreground hover:bg-red-500/20",
  merged:
    "border-transparent bg-purple-500/10 text-foreground hover:bg-purple-500/20",
};
