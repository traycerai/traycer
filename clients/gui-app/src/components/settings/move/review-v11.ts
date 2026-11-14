/** The `environment.review@1.2` facts a held entry's line reads. */
import type {
  EnvironmentReviewEntry,
  EnvironmentReviewEntryV12,
} from "@traycer/protocol/host/environment-schemas";

/** What a held executable entry does, as `environment.review@1.2` names it. */
export interface ReviewEntryFacts {
  readonly command: string | null;
  readonly event: string | null;
  readonly harness: string | null;
  readonly value: string | null;
}

const NO_FACTS: ReviewEntryFacts = {
  command: null,
  event: null,
  harness: null,
  value: null,
};

/**
 * The facts a held executable entry's line reads: what it runs and when, the
 * harness it is for, a variable's value. All null
 * for any other row, and from a host below `environment.review@1.2`.
 */
export function reviewEntryFacts(
  entry: EnvironmentReviewEntry,
): ReviewEntryFacts {
  if (!isReviewEntryV12(entry)) return NO_FACTS;
  return {
    command: entry.command,
    event: entry.event,
    harness: entry.harness,
    value: entry.value,
  };
}

function isReviewEntryV12(
  entry: EnvironmentReviewEntry,
): entry is EnvironmentReviewEntryV12 {
  return "command" in entry && "event" in entry;
}
