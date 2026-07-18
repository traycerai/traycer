/**
 * Pure directional changed-dot rules for the Epic PR View (T7).
 *
 * Dot-worthy (tech plan "Background cadence & changed-dot"):
 * - PR `state` changed
 * - a check run *concluded* (success or failure count increased) OR the
 *   overall rollup result flipped — a check merely *starting* (pending↑ only)
 *   is NOT
 * - comment count *increased* (decreases are NOT)
 *
 * First-ever sight of a PR (or of its checks/comment fields) is a silent
 * seed for that PR key — no dot. Callers handle the epic-level first-open
 * seed by writing the full baseline without setting the flag.
 */
import type {
  PrChecksRollup,
  PrLightItem,
  PrState,
} from "@traycer/protocol/host/pr-schemas";
import { fullyIdentifiedPrBase } from "@/lib/pr/pr-list-projection";

export interface PrSeenFact {
  readonly state: PrState;
  readonly checks: PrChecksRollup | null;
  readonly commentCount: number | null;
}

export type PrChecksOverall = "fail" | "pending" | "pass" | "none";

export function prSeenFactKey(item: PrLightItem): string {
  const identified = fullyIdentifiedPrBase(item);
  if (identified !== null) {
    return [
      "id",
      identified.githubHost,
      identified.base.owner,
      identified.base.repo,
      String(identified.base.prNumber),
    ].join("|");
  }
  return [
    "head",
    item.repoIdentifier.owner,
    item.repoIdentifier.repo,
    item.headRefName ?? "",
    item.prUrl ?? "",
  ].join("|");
}

export function toPrSeenFact(item: PrLightItem): PrSeenFact {
  return {
    state: item.state,
    checks: item.checksRollup,
    commentCount: item.commentCount,
  };
}

export function buildPrSeenFactsMap(
  items: readonly PrLightItem[],
): Readonly<Record<string, PrSeenFact>> {
  const next: Record<string, PrSeenFact> = {};
  for (const item of items) {
    next[prSeenFactKey(item)] = toPrSeenFact(item);
  }
  return next;
}

export function prChecksOverall(
  rollup: PrChecksRollup | null,
): PrChecksOverall {
  if (rollup === null || rollup.total === 0) return "none";
  if (rollup.failure > 0) return "fail";
  if (rollup.pending > 0) return "pending";
  return "pass";
}

/**
 * Whether the transition from `prev` → `next` for a single PR is dot-worthy.
 * Both facts must already exist in the baseline comparison (first seed is
 * handled by the caller — never call this for a PR that has no previous fact).
 */
export function isPrFactDotWorthy(prev: PrSeenFact, next: PrSeenFact): boolean {
  if (prev.state !== next.state) return true;

  if (
    next.commentCount !== null &&
    prev.commentCount !== null &&
    next.commentCount > prev.commentCount
  ) {
    return true;
  }

  return isChecksDeltaDotWorthy(prev.checks, next.checks);
}

/**
 * Directional checks-rollup rules. First appearance of a non-null rollup
 * (prev null → next non-null) is NOT dot-worthy — that is enrichment landing,
 * not a check concluding while the user was away.
 */
export function isChecksDeltaDotWorthy(
  prev: PrChecksRollup | null,
  next: PrChecksRollup | null,
): boolean {
  if (prev === null || next === null) return false;

  // A check concluded: terminal counters advanced.
  if (next.failure > prev.failure) return true;
  if (next.success > prev.success) return true;

  const prevOverall = prChecksOverall(prev);
  const nextOverall = prChecksOverall(next);
  if (prevOverall === nextOverall) return false;

  // Exclude "merely starting": success/failure unchanged and pending rose
  // (overall often flips pass/none → pending when a new run begins).
  if (
    next.success === prev.success &&
    next.failure === prev.failure &&
    next.pending > prev.pending
  ) {
    return false;
  }

  return true;
}

/**
 * Compare an incoming list against the stored baseline.
 * - `unknownKeys` (PRs with no prior fact) are seeds, not dots.
 * - Returns whether any known PR produced a dot-worthy delta, plus the
 *   merged facts map (baseline advanced for every seen PR).
 */
export function evaluatePrListAgainstBaseline(args: {
  readonly baseline: Readonly<Record<string, PrSeenFact>>;
  readonly items: readonly PrLightItem[];
}): {
  readonly hasDotWorthyDelta: boolean;
  readonly nextFacts: Readonly<Record<string, PrSeenFact>>;
} {
  const nextFacts = buildPrSeenFactsMap(args.items);
  let hasDotWorthyDelta = false;
  for (const [key, next] of Object.entries(nextFacts)) {
    const prev = Object.hasOwn(args.baseline, key)
      ? args.baseline[key]
      : undefined;
    if (prev === undefined) {
      // First sight of this PR key — silent seed, no dot.
      continue;
    }
    if (isPrFactDotWorthy(prev, next)) {
      hasDotWorthyDelta = true;
    }
  }
  return { hasDotWorthyDelta, nextFacts };
}
