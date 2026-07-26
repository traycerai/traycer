/**
 * Grouping and naming for the Checks tab.
 *
 * A flat list of fourteen rows is a wall: every row carries equal weight, and
 * the one that failed is found by reading all of them. Grouping by OUTCOME
 * puts the answer to "can this land?" in the first heading, and lets the
 * fourteen successes collapse into one line that says so.
 *
 * Kept apart from `prCheckContextDotTone`, which drives the health gauge and
 * the attention queue. That function deliberately counts a skipped check as
 * passing (it is not blocking anything); this one keeps skipped separate,
 * because a reader scanning the list wants to know a check did not run rather
 * than see it claimed as green.
 */
import type { PrCheckContext } from "@traycer/protocol/host/pr-schemas";

export type PrCheckOutcome = "failing" | "pending" | "skipped" | "successful";

export interface PrCheckGroup {
  readonly outcome: PrCheckOutcome;
  /** "1 failing check" / "2 successful checks" - already pluralized. */
  readonly heading: string;
  readonly contexts: readonly PrCheckContext[];
}

export function prCheckOutcome(context: PrCheckContext): PrCheckOutcome {
  if (context.status !== "completed") return "pending";
  if (context.conclusion === null) return "pending";
  switch (context.conclusion) {
    case "success":
      return "successful";
    case "failure":
    case "timed_out":
    case "action_required":
      return "failing";
    // A startup failure never ran to a verdict either, but unlike
    // `cancelled`/`stale` GitHub itself calls it a failure - the job errored
    // before it could even start, which is exactly the kind of thing a
    // reader needs surfaced rather than folded into "didn't run".
    case "startup_failure":
      return "failing";
    // `cancelled` and `stale` sit with `skipped` rather than with failures:
    // none of them ran to a verdict, and calling a cancelled job "failing"
    // sends a reader hunting for a defect that isn't there.
    case "skipped":
    case "cancelled":
    case "stale":
    case "neutral":
      return "skipped";
  }
}

/**
 * Failing first, then still-running, then didn't-run, then passed.
 *
 * The order is by how much the row wants attention, not by severity as such:
 * a pending check is the next thing that could become blocking, while a
 * successful one is the thing you never need to look at. Empty groups are
 * dropped, so a green PR shows exactly one heading.
 */
const OUTCOME_ORDER: readonly PrCheckOutcome[] = [
  "failing",
  "pending",
  "skipped",
  "successful",
];

const OUTCOME_NOUN: Record<PrCheckOutcome, string> = {
  failing: "failing check",
  pending: "pending check",
  skipped: "skipped check",
  successful: "successful check",
};

export function groupPrChecks(
  contexts: readonly PrCheckContext[],
): readonly PrCheckGroup[] {
  return OUTCOME_ORDER.flatMap((outcome) => {
    const matching = contexts.filter(
      (context) => prCheckOutcome(context) === outcome,
    );
    if (matching.length === 0) return [];
    return [
      {
        outcome,
        heading: `${matching.length} ${OUTCOME_NOUN[outcome]}${matching.length === 1 ? "" : "s"}`,
        contexts: matching,
      },
    ];
  });
}

/**
 * The name GitHub shows: `Run Pre-commit / pre-commit (pull_request)`.
 *
 * `name` alone is the JOB name, which is not unique - a repo running one
 * reusable workflow across five packages reports `build` five times, and a
 * list showing only that has five identical rows and no way to tell which one
 * failed. The workflow name is what separates them.
 *
 * Each part is dropped when absent rather than filled with a placeholder: a
 * third-party app's check has no workflow and no event, and `undefined /
 * Mintlify Deployment ()` would be worse than the bare name.
 */
export function formatPrCheckName(context: PrCheckContext): string {
  const stem =
    context.workflowName === null || context.workflowName.length === 0
      ? context.name
      : `${context.workflowName} / ${context.name}`;
  if (context.event === null || context.event.length === 0) return stem;
  return `${stem} (${context.event})`;
}

/**
 * A key that survives duplicate job names.
 *
 * `detailsUrl` is per-run and therefore genuinely unique where it exists;
 * everything else falls back to the composed name plus the index, because two
 * rows that are identical in every carried field still need distinct keys.
 */
export function prCheckContextKey(
  context: PrCheckContext,
  index: number,
): string {
  return context.detailsUrl ?? `${formatPrCheckName(context)}:${index}`;
}
