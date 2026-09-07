import type { PrReviewDecision } from "@traycer/protocol/host/pr-schemas";

/** How a PR's review decision is written, in the compact form a dense surface has room for. */
export const REVIEW_DECISION_LABEL: Readonly<Record<PrReviewDecision, string>> =
  {
    approved: "Approved",
    changes_requested: "Changes req.",
    review_required: "Review required",
  };
