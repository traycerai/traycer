/**
 * `environment.review@1.1` fields the sheet reads. The hook is typed as the
 * 1.0 answer (`entries` only); a 1.1 host adds `shownAt`, `acknowledgedAt`
 * and `evidence`.
 */
import type {
  EnvironmentReviewResponse,
  EnvironmentReviewResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type { ReviewEvidence } from "@/components/settings/move/retrospective-copy";

export function isReviewV11(
  review: EnvironmentReviewResponse,
): review is EnvironmentReviewResponseV11 {
  return "shownAt" in review && "evidence" in review;
}

export function reviewShownAt(
  review: EnvironmentReviewResponse,
): number | null {
  return isReviewV11(review) ? review.shownAt : null;
}

export function reviewEvidence(
  review: EnvironmentReviewResponse,
): ReviewEvidence {
  if (!isReviewV11(review)) return { version: null, at: null };
  return review.evidence;
}
