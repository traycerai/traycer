import type { Placement, Step } from "react-joyride";
import {
  TOUR_COPY,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";
import type { TourAnchor } from "@/components/onboarding/tour/tour-targets";

/**
 * The five lessons as Joyride sees them: the instruction on the card, its
 * placement and which anchor. Titles, progress, order and ids come from the
 * shared catalogue (`onboarding-tour-catalog.ts` - `TOUR_COPY` names each
 * tour once, for the card and Settings alike); nothing here is a second
 * copy of those.
 */

/** Spotlight geometry, in pixels (Joyride takes numbers, not tokens). */
export const TOUR_SPOTLIGHT_PADDING_PX = 8;
export const TOUR_SPOTLIGHT_RADIUS_PX = 8;
/** Overlay 45 / card 46: above the app, below every `z-50` Dialog. */
export const TOUR_Z_INDEX = 45;
/**
 * How long Joyride polls for an anchor the controller handed it before
 * `error:target_not_found`. Short on purpose: the controller only hands
 * over a node its own presentability filter accepted, so this wait covers
 * the rare disagreement with Joyride's visibility check - a lesson whose
 * anchor is missing never reaches it (the unanchored card shows at once).
 */
export const TOUR_TARGET_WAIT_TIMEOUT_MS = 1500;
export const TOUR_SCROLL_DURATION_MS = 300;

export interface TourLesson {
  /** What the card asks the user to do (the catalogue owns the title). */
  readonly body: string;
  readonly placement: Placement;
  readonly anchor: TourAnchor;
}

export const TOUR_LESSONS: Readonly<Record<TourId, TourLesson>> = {
  "add-folder": {
    body: "Choose a folder so your agent can work with your code.",
    placement: "bottom",
    anchor: "landing-folder-add",
  },
  "terminal-mode": {
    body: "Switch to Terminal to work with your coding agent in a terminal.",
    placement: "top",
    anchor: "landing-terminal-switch",
  },
  "submit-prompt": {
    body: "Switch back to Chat, describe what you want to build, and send it.",
    placement: "top",
    anchor: "landing-send",
  },
  "task-panels": {
    body: "Use these panels to move between agents, files, and tools.",
    placement: "right",
    anchor: "epic-sidebar-column",
  },
  history: {
    body: "Your imported sessions are here. Open a task to keep going.",
    // The anchor is one ROW (the first imported one), not the list: the
    // list is taller than the viewport, and a card placed against it lands
    // inside the cutout over the rows it points at.
    placement: "right",
    anchor: "landing-history",
  },
};

/**
 * The panels lesson with no task bound yet (the sessions branch's Next on
 * history found nothing imported to open; a prompt lesson acknowledged
 * without sending): the card says what would anchor it.
 */
export const TASK_PANELS_UNBOUND_BODY = "Open a task to continue.";

export function tourLessonTitle(tourId: TourId): string {
  return TOUR_COPY[tourId].title;
}

/**
 * An extra button on the card, for the one case a lesson can offer the
 * thing that would anchor it ("Open latest task").
 */
export interface TourStepAction {
  readonly label: string;
  readonly run: () => void;
}

/**
 * Carried on Joyride's untyped `Step.data` as a class instance: Joyride
 * deep-merges plain objects into each step and passes anything else by
 * reference, and `instanceof` is the typed read back (`tourStepAction`).
 */
class TourStepData {
  constructor(readonly action: TourStepAction) {}
}

export function tourStepAction(step: Step): TourStepAction | null {
  const data: unknown = step.data;
  return data instanceof TourStepData ? data.action : null;
}

/**
 * How the active lesson is being shown. `anchored` spotlights a resolved
 * node (Joyride scrolls it into view); `unanchored` is the same lesson as a
 * centred card with no cutout - the target is missing, timed out or
 * detached, and the user still gets Next / Skip / pause (never a trap) -
 * with, optionally, its own copy and an action that would anchor it.
 */
export type StepPresentation =
  | {
      readonly kind: "anchored";
      readonly target: () => HTMLElement | null;
      /** The card has presented: only then is the dim drawn around it. */
      readonly presented: boolean;
    }
  | {
      readonly kind: "unanchored";
      readonly content: string | null;
      readonly action: TourStepAction | null;
    };

function documentBody(): HTMLElement {
  return document.body;
}

/**
 * One Joyride step per tour in `order`, so the controlled `stepIndex` is the
 * active tour's position and Joyride's own `isLastStep` / step count read
 * true for the chain (a Settings replay is a one-tour order). Only the
 * active tour gets a real presentation; the others are placeholders that
 * validate but are never shown.
 */
export function buildTourSteps(
  order: ReadonlyArray<TourId>,
  activeTourId: TourId,
  presentation: StepPresentation,
): Step[] {
  return order.map((tourId) => {
    const lesson = TOUR_LESSONS[tourId];
    const base = {
      id: tourId,
      title: tourLessonTitle(tourId),
      content: lesson.body,
    };
    if (tourId !== activeTourId) {
      return {
        ...base,
        target: documentBody,
        placement: "center",
        hideOverlay: true,
        skipScroll: true,
      };
    }
    if (presentation.kind === "unanchored") {
      return {
        ...base,
        content: presentation.content ?? lesson.body,
        ...(presentation.action === null
          ? {}
          : { data: new TourStepData(presentation.action) }),
        target: documentBody,
        placement: "center",
        hideOverlay: true,
        skipScroll: true,
      };
    }
    return {
      ...base,
      target: presentation.target,
      placement: lesson.placement,
      // No dim before the card: Joyride draws the overlay through its
      // target wait and scroll transit, both card-less. The step is
      // re-merged when `presented` flips, and the cutout opens then.
      hideOverlay: !presentation.presented,
    };
  });
}
