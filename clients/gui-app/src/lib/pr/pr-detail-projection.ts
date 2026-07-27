/**
 * Pure projection helpers over `pr.subscribeDetail`'s heavy sections (checks
 * contexts, chronological activity) for the PR full-view tile. No React, no
 * store access - mirrors `pr-list-projection.ts`'s conventions.
 */
import type {
  PrActivityItem,
  PrActivitySection,
  PrActor,
  PrCheckContext,
  PrDetailCore,
  PrReviewState,
} from "@traycer/protocol/host/pr-schemas";
import type { PrChecksDotTone } from "./pr-list-projection";

export type PrReviewerState = PrReviewState | "requested";

export interface PrReviewerRow {
  readonly actor: PrActor;
  readonly state: PrReviewerState;
}

/**
 * Reviewers with their latest state. Activity is chronological, so a later
 * review from the same login wins; a pending re-request in `reviewRequests`
 * then overrides to "requested", since re-requesting retracts the standing
 * verdict and waits for a fresh one.
 *
 * Reconstructed from the ≤20-item activity window, so an older approval can
 * be pushed off-window by newer comments - callers that claim "no reviews"
 * must qualify it against `isTruncated` and `core.reviewDecision`.
 */
export function prReviewerRows(
  core: PrDetailCore,
  activity: PrActivitySection,
): readonly PrReviewerRow[] {
  const byLogin = new Map<string, PrReviewerRow>();
  activity.items
    .filter(
      (
        item,
      ): item is Extract<PrActivityItem, { kind: "review" }> & {
        author: PrActor;
      } => item.kind === "review" && item.author !== null,
    )
    .forEach((item) => {
      byLogin.set(item.author.login, {
        actor: item.author,
        state: item.state,
      });
    });
  core.reviewRequests.forEach((request) => {
    byLogin.set(request.login, { actor: request, state: "requested" });
  });
  return [...byLogin.values()];
}

/** Unique actors seen on the PR: the author plus everyone in the activity feed. */
export function prParticipantActors(
  core: PrDetailCore,
  activity: PrActivitySection,
): readonly PrActor[] {
  const byLogin = new Map<string, PrActor>();
  if (core.author !== null) byLogin.set(core.author.login, core.author);
  activity.items
    .filter(
      (item): item is PrActivityItem & { author: PrActor } =>
        item.author !== null,
    )
    .forEach((item) => {
      byLogin.set(item.author.login, item.author);
    });
  return [...byLogin.values()];
}

export function prCheckContextDotTone(
  context: PrCheckContext,
): PrChecksDotTone {
  if (context.status !== "completed") return "pending";
  if (context.conclusion === null) return "pending";
  if (
    context.conclusion === "success" ||
    context.conclusion === "neutral" ||
    context.conclusion === "skipped"
  ) {
    return "ok";
  }
  if (context.conclusion === "cancelled" || context.conclusion === "stale") {
    return "none";
  }
  return "fail";
}

export function formatPrCheckStatusLabel(context: PrCheckContext): string {
  if (context.status === "queued") return "Queued";
  if (context.status === "in_progress") return "Running";
  // These three never reach a `conclusion` - GitHub reports them as
  // in-flight states of their own, distinct from "completed" - so falling
  // through to `formatPrCheckConclusionLabel(null)` would mislabel every one
  // of them "Unknown" instead of describing what's actually happening.
  if (context.status === "pending") return "Pending";
  if (context.status === "requested") return "Requested";
  if (context.status === "waiting") return "Waiting";
  return formatPrCheckConclusionLabel(context.conclusion);
}

function formatPrCheckConclusionLabel(
  conclusion: PrCheckContext["conclusion"],
): string {
  if (conclusion === null) return "Unknown";
  if (conclusion === "success") return "Success";
  if (conclusion === "failure") return "Failure";
  if (conclusion === "neutral") return "Neutral";
  if (conclusion === "cancelled") return "Cancelled";
  if (conclusion === "skipped") return "Skipped";
  if (conclusion === "timed_out") return "Timed out";
  if (conclusion === "stale") return "Stale";
  if (conclusion === "startup_failure") return "Startup failed";
  return "Action required";
}

export function formatPrReviewStateLabel(state: PrReviewState): string {
  if (state === "approved") return "Approved";
  if (state === "changes_requested") return "Requested changes";
  if (state === "commented") return "Commented";
  if (state === "dismissed") return "Dismissed";
  return "Pending";
}

export function formatPrActorName(actor: PrActor | null): string {
  return actor === null ? "Unknown" : actor.login;
}

export function prActivityItemKey(item: PrActivityItem): string {
  return `${item.kind}:${item.id}`;
}
