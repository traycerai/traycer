/** Grouping and naming for the Checks tab. */
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
    // A startup failure never ran to a verdict either, but unlike `cancelled`/`stale` GitHub itself calls it a failure - the job errored before it could even start, which is exactly the kind of thing a reader needs surfaced rather than folded into "didn't run".
    case "startup_failure":
      return "failing";
    // `cancelled` and `stale` sit with `skipped` rather than with failures: none of them ran to a verdict, and calling a cancelled job "failing" sends a reader hunting for a defect that isn't there.
    case "skipped":
    case "cancelled":
    case "stale":
    case "neutral":
      return "skipped";
  }
}

/** Failing first, then still-running, then didn't-run, then passed. */
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

/** The name GitHub shows: `Run Pre-commit / pre-commit (pull_request)`. */
export function formatPrCheckName(context: PrCheckContext): string {
  const stem =
    context.workflowName === null || context.workflowName.length === 0
      ? context.name
      : `${context.workflowName} / ${context.name}`;
  if (context.event === null || context.event.length === 0) return stem;
  return `${stem} (${context.event})`;
}

/** A key that survives duplicate job names. */
export function prCheckContextKey(
  context: PrCheckContext,
  index: number,
): string {
  return `${context.detailsUrl ?? formatPrCheckName(context)}:${index}`;
}
