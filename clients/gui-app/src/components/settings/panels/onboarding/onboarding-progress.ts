import type {
  OnboardingFlowData,
  TourStatus,
} from "@/stores/onboarding/onboarding-flow-store";
import {
  TOUR_COPY,
  TOUR_IDS,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";

/**
 * What Settings ▸ Onboarding says about the flow's progress, derived from
 * the flow store's data and nothing else. Pure, so the copy rules - which
 * states count as done, what "paused" names - are tested without a render.
 *
 * Five tours, always: the four other lessons are a demo, an editor and a
 * dialog, carry no progress, and never inflate completion. `bypassed` is
 * counted on its own and never as done - a tour the chain jumped past is
 * still there to replay, and saying "5 of 5" over it would be a lie.
 */
export interface OnboardingProgressSummary {
  readonly total: number;
  readonly done: number;
  readonly available: number;
  readonly bypassed: number;
  readonly active: number;
  /** "Not started" / "In progress (page 2)" / "Done" / "Skipped". */
  readonly welcome: string;
  /** The chain's state in words, naming the current tour where there is one. */
  readonly chain: string;
  /** Set for an install that finished the OLD first-run tour. */
  readonly legacyNote: string | null;
}

export const LEGACY_COMPLETED_NOTE =
  "You completed the earlier tour. Explore the new lessons whenever you like.";

function countTours(data: OnboardingFlowData, status: TourStatus): number {
  return TOUR_IDS.filter((id) => data.tours[id].status === status).length;
}

function welcomeLabel(data: OnboardingFlowData): string {
  switch (data.modal) {
    case "pending":
      return "Not started";
    case "in-progress":
      return `In progress (page ${data.modalPage})`;
    case "done":
      return "Done";
    case "skipped":
      return "Skipped";
  }
}

function chainLabel(data: OnboardingFlowData): string {
  const current =
    data.activeTourId === null ? null : TOUR_COPY[data.activeTourId].title;
  switch (data.chain) {
    case "pending":
      return "Not started";
    case "active":
      return current === null ? "Active" : `Active - ${current}`;
    case "paused":
      return current === null ? "Paused" : `Paused at ${current}`;
    case "completed":
      return "Completed";
    case "skipped":
      return "Skipped";
  }
}

export function summarizeOnboardingProgress(
  data: OnboardingFlowData,
): OnboardingProgressSummary {
  return {
    total: TOUR_IDS.length,
    done: countTours(data, "done"),
    available: countTours(data, "available"),
    bypassed: countTours(data, "bypassed"),
    active: countTours(data, "active"),
    welcome: welcomeLabel(data),
    chain: chainLabel(data),
    legacyNote: data.legacyCompleted ? LEGACY_COMPLETED_NOTE : null,
  };
}

/** The status word a tour card shows beside its title. */
export function tourStatusLabel(
  data: OnboardingFlowData,
  tourId: TourId,
): string {
  const status = data.tours[tourId].status;
  if (status === "active") {
    return data.chain === "paused" ? "Paused here" : "Active";
  }
  if (status === "done") return "Done";
  if (status === "bypassed") return "Bypassed";
  return "Available";
}

/** The verb on a tour card: start a fresh one, replay a finished one, restart a live one. */
export function tourActionLabel(
  data: OnboardingFlowData,
  tourId: TourId,
): string {
  const status = data.tours[tourId].status;
  if (status === "active") return "Restart tour";
  if (status === "available") return "Start tour";
  return "Replay tour";
}
