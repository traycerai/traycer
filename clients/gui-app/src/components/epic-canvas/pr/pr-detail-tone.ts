/**
 * The PR full view's one state palette, in THEME TOKENS.
 *
 * The GitHub-clone version hardcoded `bg-green-600` / `bg-red-600` /
 * `bg-purple-600` / `bg-amber-500` across the header, merge box, checks list
 * and files list. Those are fixed Tailwind ramps: they ignore the nine theme
 * presets (dracula, catppuccin, tokyo-night, gruvbox, vercel, github, …),
 * each of which already redefines `--success` / `--warning` / `--destructive`
 * for its own surfaces. A view that opts out of them is the only thing in the
 * app whose "green" is a different green.
 *
 * `-foreground` variants are the contrast-checked pair meant to sit ON a
 * surface as text or as a meaning-carrying glyph; the bare token is the fill.
 * See `worktree-pr-state-palette.ts` for the same lesson learned the hard way
 * on the PR state pill.
 */
import type {
  PrDetailCore,
  PrReviewDecision,
  PrReviewState,
} from "@traycer/protocol/host/pr-schemas";
import type { PrCheckCounts } from "@/lib/pr/pr-attention-queue";
import type { PrChecksDotTone } from "@/lib/pr/pr-list-projection";

/** Text / glyph colour for a tone. */
export const PR_TONE_TEXT_CLASS: Record<PrChecksDotTone, string> = {
  ok: "text-success-foreground",
  fail: "text-destructive",
  pending: "text-warning-foreground",
  none: "text-muted-foreground/60",
};

/** Solid fill for a tone - meters, dots, segment bars. */
export const PR_TONE_FILL_CLASS: Record<PrChecksDotTone, string> = {
  ok: "bg-success",
  fail: "bg-destructive",
  pending: "bg-warning",
  none: "bg-muted-foreground/25",
};

/** Tinted surface for a tone - the queue hero's frame, banner backgrounds. */
export const PR_TONE_SURFACE_CLASS: Record<PrChecksDotTone, string> = {
  ok: "border-success/25 bg-success/5",
  fail: "border-destructive/30 bg-destructive/5",
  pending: "border-warning/25 bg-warning/5",
  none: "border-border/60",
};

/** Bordered pill for a tone - verdict chips, inline state labels. */
export const PR_TONE_CHIP_CLASS: Record<PrChecksDotTone, string> = {
  ok: "border-success/30 bg-success/10 text-success-foreground",
  fail: "border-destructive/30 bg-destructive/10 text-destructive",
  pending: "border-warning/30 bg-warning/10 text-warning-foreground",
  none: "border-border/60 bg-muted/40 text-muted-foreground",
};

/** Diffstat additions / deletions, the only two-colour pair in the view. */
export const PR_DIFF_ADDED_CLASS = "text-success-foreground";
export const PR_DIFF_REMOVED_CLASS = "text-destructive";

/**
 * Tone for a PR's own state. A draft is deliberately neutral rather than green:
 * it is open, but it is not asking to be merged, so it should not read as ready.
 */
export function prStateTone(core: PrDetailCore): PrChecksDotTone {
  if (core.state === "closed") return "fail";
  if (core.state !== "open") return "none";
  return core.isDraft === true ? "none" : "ok";
}

/** Worst-first: one failure outranks any number of passes. */
export function prChecksTone(counts: PrCheckCounts): PrChecksDotTone {
  if (counts.total === 0) return "none";
  if (counts.failing > 0) return "fail";
  if (counts.pending > 0) return "pending";
  // `total` counts contexts the three buckets don't (skipped, neutral,
  // cancelled), so reaching here with `passed === 0` means every check settled
  // to something none of them names. Claiming "ok" would report a green run
  // that nothing actually passed. Matches `prChecksSummary`.
  if (counts.passed === 0) return "none";
  return "ok";
}

export function prReviewDecisionTone(
  decision: PrReviewDecision,
): PrChecksDotTone {
  if (decision === "approved") return "ok";
  if (decision === "changes_requested") return "fail";
  return "pending";
}

/**
 * Tone for one submitted review. `commented` and `dismissed` are deliberately
 * toneless: neither carries a verdict, and colouring them would make a
 * drive-by remark read as an outcome.
 */
export function prReviewStateTone(state: PrReviewState): PrChecksDotTone {
  if (state === "approved") return "ok";
  if (state === "changes_requested") return "fail";
  if (state === "pending") return "pending";
  return "none";
}

/** The checks gauge's one-line value, matched to {@link prChecksTone}. */
export function formatPrChecksValue(counts: PrCheckCounts): string {
  if (counts.total === 0) return "None reported";
  if (counts.failing > 0) return `${counts.failing} failing`;
  if (counts.pending > 0) return `${counts.pending} running`;
  // See {@link prChecksTone}: all-skipped/neutral/cancelled would otherwise
  // read as "0 passed", which states a pass count where nothing passed.
  if (counts.passed === 0) {
    return `${counts.total} check${counts.total === 1 ? "" : "s"}`;
  }
  return `${counts.passed} passed`;
}
