import type { PlanSegmentModel } from "@/stores/composer/chat-store";

// Pure plan-card display helpers shared by the plan renderer (`plan-segment.tsx`)
// and the chat search projection (`chat-find.ts`). The card shows a headline, a
// status badge, an optional subtitle, and the first N steps; the full markdown
// preview and remaining steps live behind an unopened dialog. Keeping these
// derivations in one place stops the projection from indexing dialog-only text
// the card never renders.

export const PLAN_PREVIEW_STEP_LIMIT = 4;

export const PLAN_STATUS_LABELS: Record<
  PlanSegmentModel["planStatus"],
  string
> = {
  drafting: "Drafting",
  ready: "Ready",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

// The status badge is suppressed for `awaiting_approval` (the inline
// Implement/Reject actions convey it), so it renders no findable label there.
export function planStatusBadgeLabel(
  planStatus: PlanSegmentModel["planStatus"],
): string | null {
  if (planStatus === "awaiting_approval") return null;
  return PLAN_STATUS_LABELS[planStatus];
}

// The single title shown for a plan: the harness-provided title when specific,
// else the plan's own first heading/line. A generic "Plan" title is dropped so
// the card/modal don't echo the "Plan" label the header already shows.
export function planHeadline(
  segment: PlanSegmentModel,
  markdown: string,
): string {
  const title = segment.title?.trim() ?? "";
  if (title.length > 0 && !isGenericPlanTitle(title)) return title;
  return firstMeaningfulLine(markdown);
}

export function planCardSubtitle(
  segment: PlanSegmentModel,
  cardHeadline: string,
): string | null {
  const summary = segment.summary?.trim() ?? "";
  if (summary.length > 0 && summary !== cardHeadline) return summary;
  return null;
}

export function planFallbackMarkdown(segment: PlanSegmentModel): string {
  if (segment.markdownPreview.trim().length > 0) return segment.markdownPreview;
  const parts = [`# ${planTitle(segment)}`];
  if (segment.summary !== null && segment.summary.trim().length > 0) {
    parts.push(segment.summary.trim());
  }
  if (segment.steps.length > 0) {
    parts.push(
      segment.steps
        .map((step) => `- ${step.activeForm ?? step.text}`)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

function planTitle(segment: PlanSegmentModel): string {
  if (segment.title !== null && segment.title.trim().length > 0) {
    return segment.title.trim();
  }
  return "Implementation Plan";
}

function firstMeaningfulLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((part) =>
      part
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s*/, "")
        .trim(),
    )
    .find((part) => part.length > 0 && !isGenericPlanTitle(part));
  return line ?? "Review the proposed plan before continuing.";
}

const GENERIC_PLAN_TITLES = new Set(["plan", "implementation plan"]);

function isGenericPlanTitle(title: string): boolean {
  return GENERIC_PLAN_TITLES.has(title.trim().toLowerCase());
}
