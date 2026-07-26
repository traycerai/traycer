/**
 * Derives the PR full view's attention queue: the things about a pull request
 * that need a decision, ranked, each one routable to an agent.
 *
 * This is the inversion that separates our PR view from GitHub's. GitHub's
 * page is a conversation you can act inside; ours is read-only (decision #4),
 * so a chronological feed presents a discussion with no way to participate.
 * What we can do that GitHub cannot is hand a finding straight to the agent
 * that wrote the branch - so the hero is a queue of blockers, not a timeline.
 *
 * Pure: no React, no store access. Mirrors `pr-detail-projection.ts`.
 *
 * HONESTY CONTRACT: the frame's windows are capped (≤20 activity items, ≤50
 * check contexts). A queue derived from a truncated window can UNDER-report,
 * and "3 things need you" reads as exhaustive. Callers must surface
 * {@link PrAttentionQueue.isWindowTruncated} wherever they render the count.
 */
import type {
  PrActivitySection,
  PrActor,
  PrChecksSection,
  PrDetailCore,
  PrReviewDecision,
} from "@traycer/protocol/host/pr-schemas";
import {
  formatPrCheckStatusLabel,
  prCheckContextDotTone,
} from "./pr-detail-projection";

export type PrAttentionKind =
  "check-failure" | "changes-requested" | "review-required";

export interface PrAttentionItem {
  /** Stable across frames so React keys don't churn on every poll. */
  readonly key: string;
  readonly kind: PrAttentionKind;
  readonly title: string;
  /**
   * The one line of evidence we can show. For a check this is its conclusion
   * label, NOT a log excerpt - the wire carries no check logs, so promising
   * an error message here would be a lie the data can't back.
   */
  readonly detail: string | null;
  readonly actor: PrActor | null;
  readonly detailsUrl: string | null;
  readonly createdAt: number | null;
}

export interface PrCheckCounts {
  readonly passed: number;
  readonly failing: number;
  readonly pending: number;
  readonly total: number;
}

export interface PrAttentionQueue {
  /** Ranked most-actionable first; empty means the calm state is correct. */
  readonly items: readonly PrAttentionItem[];
  readonly isWindowTruncated: boolean;
  readonly checkCounts: PrCheckCounts;
  readonly reviewDecision: PrReviewDecision | null;
}

const KIND_RANK: Record<PrAttentionKind, number> = {
  // A failing check is the most actionable thing on a PR: it names a specific
  // job, and its fix is mechanical. A human's requested changes need reading
  // before they can be acted on. "Review required" is not a defect at all -
  // nobody has looked yet - so it sorts last.
  "check-failure": 0,
  "changes-requested": 1,
  "review-required": 2,
};

export function countPrChecks(checks: PrChecksSection): PrCheckCounts {
  let passed = 0;
  let failing = 0;
  let pending = 0;
  for (const context of checks.contexts) {
    const tone = prCheckContextDotTone(context);
    if (tone === "ok") passed += 1;
    else if (tone === "fail") failing += 1;
    else if (tone === "pending") pending += 1;
    // `none` (cancelled / stale) counts toward the total but is not a signal
    // in either direction - it neither blocks the merge nor proves health.
  }
  return { passed, failing, pending, total: checks.contexts.length };
}

/**
 * Reviewers whose LATEST review still requests changes.
 *
 * Activity is chronological, so a later review from the same login supersedes
 * an earlier one - an "approved" after a "changes_requested" clears the block.
 * A pending re-request in `core.reviewRequests` also clears it: on GitHub,
 * re-requesting review retracts the standing objection and waits for a fresh
 * verdict, so keeping the old one would show a blocker that no longer blocks.
 */
function changesRequestedItems(
  core: PrDetailCore,
  activity: PrActivitySection,
): readonly PrAttentionItem[] {
  const latestByLogin = new Map<
    string,
    { readonly item: PrActivityItemReview; readonly actor: PrActor }
  >();
  for (const entry of activity.items) {
    if (entry.kind !== "review" || entry.author === null) continue;
    latestByLogin.set(entry.author.login, {
      item: entry,
      actor: entry.author,
    });
  }
  const reRequested = new Set(
    core.reviewRequests.map((request) => request.login),
  );
  const items: PrAttentionItem[] = [];
  for (const [login, latest] of latestByLogin) {
    if (latest.item.state !== "changes_requested") continue;
    if (reRequested.has(login)) continue;
    items.push({
      key: `review:${latest.item.id}`,
      kind: "changes-requested",
      title: login,
      detail: firstMeaningfulLine(latest.item.body),
      actor: latest.actor,
      detailsUrl: core.prUrl,
      createdAt: latest.item.createdAt,
    });
  }
  return items;
}

type PrActivityItemReview = Extract<
  PrActivitySection["items"][number],
  { readonly kind: "review" }
>;

/**
 * The first non-blank line of a review body, as the queue row's evidence.
 * Markdown is deliberately NOT rendered here - the row is a one-line summary
 * and the full body lives one click away on the Feedback tab.
 */
function firstMeaningfulLine(body: string): string | null {
  for (const rawLine of body.split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (line.length > 0) return line;
  }
  return null;
}

/**
 * Folds a detail frame into the ranked queue.
 *
 * Only OPEN pull requests produce items: on a merged or closed PR a failing
 * check is history, not a blocker, and offering "fix this" would invite work
 * on a branch nobody is going to land.
 */
export function derivePrAttentionQueue(args: {
  readonly core: PrDetailCore;
  readonly checks: PrChecksSection;
  readonly activity: PrActivitySection;
}): PrAttentionQueue {
  const checkCounts = countPrChecks(args.checks);
  const isWindowTruncated =
    args.checks.isTruncated || args.activity.isTruncated;
  if (args.core.state !== "open") {
    return {
      items: [],
      isWindowTruncated,
      checkCounts,
      reviewDecision: args.core.reviewDecision,
    };
  }

  const items: PrAttentionItem[] = [];
  for (const context of args.checks.contexts) {
    if (prCheckContextDotTone(context) !== "fail") continue;
    items.push({
      key: `check:${context.name}`,
      kind: "check-failure",
      title: context.name,
      detail: formatPrCheckStatusLabel(context),
      actor: null,
      detailsUrl: context.detailsUrl,
      createdAt: null,
    });
  }

  const blocking = changesRequestedItems(args.core, args.activity);
  items.push(...blocking);

  // Only surface "review required" when nothing else already blocks: beside a
  // concrete objection it is noise, since an approving review is implied by
  // resolving the objection.
  if (args.core.reviewDecision === "review_required" && blocking.length === 0) {
    items.push({
      key: "review-required",
      kind: "review-required",
      title: "Review required",
      detail: "An approving review is required before merging.",
      actor: null,
      detailsUrl: args.core.prUrl,
      createdAt: null,
    });
  }

  items.sort((left, right) => {
    const kindDelta = KIND_RANK[left.kind] - KIND_RANK[right.kind];
    if (kindDelta !== 0) return kindDelta;
    // Within a kind, newest first - a reviewer's latest objection is the one
    // still in the author's head. Undated rows (checks) keep frame order,
    // which is the order GitHub reported them in.
    if (left.createdAt === null && right.createdAt === null) return 0;
    if (left.createdAt === null) return 1;
    if (right.createdAt === null) return -1;
    return right.createdAt - left.createdAt;
  });

  return {
    items,
    isWindowTruncated,
    checkCounts,
    reviewDecision: args.core.reviewDecision,
  };
}

/**
 * Headline for the queue hero. Separate from the items so the calm state and
 * the blocked state are rendered by one component from one derivation.
 */
export function formatPrAttentionHeadline(queue: PrAttentionQueue): string {
  const count = queue.items.length;
  if (count === 0) return "Nothing blocking";
  return `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you`;
}

/** Sub-line for the queue hero: what makes up the count, or why it's calm. */
export function formatPrAttentionSubline(
  queue: PrAttentionQueue,
): string | null {
  if (queue.items.length === 0) {
    const parts = [
      queue.checkCounts.passed > 0
        ? `${queue.checkCounts.passed} check${queue.checkCounts.passed === 1 ? "" : "s"} passed`
        : null,
      queue.checkCounts.pending > 0
        ? `${queue.checkCounts.pending} still running`
        : null,
      queue.reviewDecision === "approved" ? "approved" : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  const failing = queue.items.filter(
    (item) => item.kind === "check-failure",
  ).length;
  const reviews = queue.items.filter(
    (item) => item.kind === "changes-requested",
  ).length;
  const parts = [
    failing > 0 ? `${failing} failing check${failing === 1 ? "" : "s"}` : null,
    reviews > 0
      ? `${reviews} review${reviews === 1 ? "" : "s"} blocking`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
