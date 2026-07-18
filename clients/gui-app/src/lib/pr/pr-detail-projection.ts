/**
 * Pure projection helpers over `pr.subscribeDetail`'s heavy sections (checks
 * contexts, chronological activity) for the PR full-view tile. No React, no
 * store access - mirrors `pr-list-projection.ts`'s conventions.
 */
import type {
  PrActivityItem,
  PrActor,
  PrCheckContext,
  PrReviewState,
} from "@traycer/protocol/host/pr-schemas";
import type { PrChecksDotTone } from "./pr-list-projection";

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
