import { describe, expect, it } from "vitest";
import {
  TOUR_COPY,
  BRANCH_TOUR_ORDER,
  firstStepOf,
  isTourId,
  LESSON_IDS,
  nextStepOf,
  TOUR_IDS,
  TOUR_STEP_IDS,
  type OnboardingBranch,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";

describe("onboarding-tour-catalog", () => {
  it("every TOUR_STEP_IDS[tour] is non-empty, and step ids are unique across ALL tours", () => {
    const allSteps: string[] = [];
    for (const tourId of TOUR_IDS) {
      const steps = TOUR_STEP_IDS[tourId];
      expect(steps.length).toBeGreaterThan(0);
      allSteps.push(...steps);
    }
    // A step id is looked up by value alone (`indexOf`/`some`), never scoped
    // to its tour, so a collision across two tours would silently resolve
    // against the wrong one.
    expect(new Set(allSteps).size).toBe(allSteps.length);
  });

  it("every BRANCH_TOUR_ORDER[branch] ends with task-panels, and contains only known ids with no duplicates", () => {
    const branches = Object.keys(
      BRANCH_TOUR_ORDER,
    ) as ReadonlyArray<OnboardingBranch>;
    for (const branch of branches) {
      const order = BRANCH_TOUR_ORDER[branch];
      expect(order.at(-1)).toBe("task-panels");
      for (const tourId of order) {
        expect(TOUR_IDS).toContain(tourId);
      }
      expect(new Set(order).size).toBe(order.length);
    }
  });

  it("LESSON_IDS starts with TOUR_IDS in order, and has no duplicates", () => {
    expect(LESSON_IDS.slice(0, TOUR_IDS.length)).toEqual(TOUR_IDS);
    expect(new Set(LESSON_IDS).size).toBe(LESSON_IDS.length);
  });

  it.each(TOUR_IDS)("isTourId(%s) is true", (tourId) => {
    expect(isTourId(tourId)).toBe(true);
  });

  it.each(["split-screen", ""])("isTourId(%j) is false", (value) => {
    expect(isTourId(value)).toBe(false);
  });

  it.each(TOUR_IDS)("firstStepOf(%s) is TOUR_STEP_IDS[tour][0]", (tourId) => {
    expect(firstStepOf(tourId)).toBe(TOUR_STEP_IDS[tourId][0]);
  });

  describe("nextStepOf", () => {
    it.each(TOUR_IDS)("returns null on the last step of %s", (tourId) => {
      const steps = TOUR_STEP_IDS[tourId];
      const lastStep = steps[steps.length - 1];
      expect(nextStepOf(tourId, lastStep)).toBeNull();
    });

    it.each(TOUR_IDS)("returns null on an unknown step for %s", (tourId) => {
      expect(nextStepOf(tourId, "nope")).toBeNull();
    });

    it.each(TOUR_IDS)(
      "nextStepOf(%s, null) normalises to the first step",
      (tourId: TourId) => {
        expect(nextStepOf(tourId, null)).toBe(
          nextStepOf(tourId, firstStepOf(tourId)),
        );
      },
    );
  });

  it("names every tour with a non-empty title and summary, all distinct", () => {
    const titles = TOUR_IDS.map((tour) => TOUR_COPY[tour].title);
    for (const tour of TOUR_IDS) {
      expect(TOUR_COPY[tour].title.length).toBeGreaterThan(0);
      expect(TOUR_COPY[tour].summary.length).toBeGreaterThan(0);
    }
    expect(new Set(titles).size).toBe(titles.length);
  });
});
