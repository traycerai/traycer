import type { PrReviewDecision } from "@traycer/protocol/host/pr-schemas";

/**
 * How a PR's review decision is written, in the compact form a dense surface
 * has room for.
 *
 * One copy site, for the same reason `pr-source-notice-message.ts` is one: the
 * detail card and the composer's PR-mention preview now both render this fact,
 * and "Changes req." in one place with "Changes requested" in the other reads
 * as two different states rather than one fact shown twice.
 */
export const REVIEW_DECISION_LABEL: Readonly<Record<PrReviewDecision, string>> =
  {
    approved: "Approved",
    changes_requested: "Changes req.",
    review_required: "Review required",
  };
