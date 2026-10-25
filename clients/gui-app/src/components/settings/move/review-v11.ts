/**
 * `environment.review@1.1` and `@1.2` fields the sheet reads. The hook is
 * typed as the 1.0 answer (`entries` only); a 1.1 host adds `shownAt`,
 * `acknowledgedAt` and `evidence`, and a 1.2 host each entry's facts.
 */
import type {
  EnvironmentReviewEntry,
  EnvironmentReviewEntryV12,
  EnvironmentReviewResponse,
  EnvironmentReviewResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type { ReviewEvidence } from "@/components/settings/move/retrospective-copy";

export function isReviewV11(
  review: EnvironmentReviewResponse,
): review is EnvironmentReviewResponseV11 {
  return "shownAt" in review && "evidence" in review;
}

export function reviewEvidence(
  review: EnvironmentReviewResponse,
): ReviewEvidence {
  if (!isReviewV11(review)) return { version: null, at: null };
  return review.evidence;
}

/** What a held executable entry does, as `environment.review@1.2` names it. */
export interface ReviewEntryFacts {
  readonly command: string | null;
  readonly event: string | null;
  readonly description: string | null;
  readonly harness: string | null;
  readonly value: string | null;
}

const NO_FACTS: ReviewEntryFacts = {
  command: null,
  event: null,
  description: null,
  harness: null,
  value: null,
};

/**
 * The facts a held executable entry's line reads: what it runs and when, a
 * skill's description, the harness it is for, a variable's value. All null
 * for any other row, and from a host below `environment.review@1.2`.
 */
export function reviewEntryFacts(
  entry: EnvironmentReviewEntry,
): ReviewEntryFacts {
  if (!isReviewEntryV12(entry)) return NO_FACTS;
  return {
    command: entry.command,
    event: entry.event,
    description: entry.description,
    harness: entry.harness,
    value: entry.value,
  };
}

function isReviewEntryV12(
  entry: EnvironmentReviewEntry,
): entry is EnvironmentReviewEntryV12 {
  return "command" in entry && "event" in entry;
}
