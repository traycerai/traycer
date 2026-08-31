import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import {
  OnboardingPhoneDiorama,
  type OnboardingPhoneSceneId,
} from "@/components/onboarding/onboarding-phone-diorama";
import {
  STORY_STEPS,
  storyStepDuration,
} from "@/components/onboarding/onboarding-story-script";

// `useReducedMotion` memoises the media-query answer in a module-level ref the
// first time any component calls it, so a `matchMedia` stub can only decide the
// answer once per file. Driving the hook itself keeps both arms — animated and
// pinned — in one suite.
const motionState = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => motionState.reducedMotion };
});

function renderScene(scene: OnboardingPhoneSceneId): void {
  render(
    <LazyMotion features={domAnimation}>
      <OnboardingPhoneDiorama scene={scene} />
    </LazyMotion>,
  );
}

function attributes(testId: string, name: string): ReadonlyArray<string> {
  return screen
    .getAllByTestId(testId)
    .map((element) => element.getAttribute(name) ?? "");
}

function texts(testId: string): ReadonlyArray<string> {
  return screen.getAllByTestId(testId).map((element) => element.textContent);
}

const LAST_STORY_STEP = STORY_STEPS.length - 1;

/** Hold out the beat at `step`, so the next one reveals. */
function advanceStoryBeat(step: number): void {
  act(() => {
    vi.advanceTimersByTime(storyStepDuration(step, LAST_STORY_STEP));
  });
}

function storyPanesThrough(step: number): ReadonlyArray<string> {
  return STORY_STEPS.slice(0, step + 1).map((beat) => beat.pane);
}

describe("OnboardingPhoneDiorama", () => {
  beforeEach(() => {
    motionState.reducedMotion = false;
  });
  // `globals: false`, so RTL never registers its own auto-cleanup.
  afterEach(cleanup);

  describe("scenes", () => {
    it("draws the drawer over the task screen with the hamburger spotlit", () => {
      renderScene("drawer");

      expect(
        screen
          .getByTestId("onboarding-phone-diorama")
          .getAttribute("data-scene"),
      ).toBe("drawer");
      expect(attributes("onboarding-phone-header-glyph", "data-glyph")).toEqual(
        ["menu", "switcher", "bell"],
      );
      expect(
        attributes("onboarding-phone-header-glyph", "data-spotlit"),
      ).toEqual(["true", "false", "false"]);
      // Three live tasks the cycle walks, then the two dimmed older rows that
      // keep the drawer's composition honest at miniature scale.
      expect(texts("onboarding-phone-drawer-task")).toEqual([
        "Team usage limits2m",
        "Billing service1h",
        "Usage sync audit3d",
        "Provider pack audit1w",
        "Release notes draft2w",
      ]);
      expect(screen.queryByTestId("onboarding-phone-sheet")).toBeNull();
    });

    it("draws the switcher sheet with its category bar and the stack spotlit", () => {
      renderScene("switcher");

      expect(
        attributes("onboarding-phone-header-glyph", "data-spotlit"),
      ).toEqual(["false", "true", "false"]);
      // The mobile bar's own labels: "Chats", not the desktop rail's "Agents".
      expect(texts("onboarding-phone-switcher-tab")).toEqual([
        "Chats",
        "Artifacts",
        "Git Diff",
        "Terminals",
      ]);
      expect(
        attributes("onboarding-phone-switcher-tab", "data-active"),
      ).toEqual(["true", "false", "false", "false"]);
      // The first category's rows, so the bar and the body agree.
      expect(texts("onboarding-phone-sheet-row")).toEqual([
        "Team usage limits",
        "Grace-period plan",
        "API path audit",
      ]);
      expect(screen.queryByTestId("onboarding-phone-drawer")).toBeNull();
    });

    it("opens the story on the script's first beat, with no glyph spotlit", () => {
      renderScene("story");

      expect(
        attributes("onboarding-phone-header-glyph", "data-spotlit"),
      ).toEqual(["false", "false", "false"]);
      expect(texts("onboarding-phone-story-beat")).toEqual([
        STORY_STEPS[0].text,
      ]);
      expect(screen.queryByTestId("onboarding-phone-drawer")).toBeNull();
      expect(screen.queryByTestId("onboarding-phone-sheet")).toBeNull();
    });
  });

  describe("motion", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("slides the drawer in after the opening beat, then cycles the active task", () => {
      renderScene("drawer");

      const drawer = screen.getByTestId("onboarding-phone-drawer");
      expect(drawer.getAttribute("data-open")).toBe("false");

      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(drawer.getAttribute("data-open")).toBe("true");
      expect(attributes("onboarding-phone-drawer-task", "data-active")).toEqual(
        ["true", "false", "false", "false", "false"],
      );

      act(() => {
        vi.advanceTimersByTime(1900);
      });
      expect(attributes("onboarding-phone-drawer-task", "data-active")).toEqual(
        ["false", "true", "false", "false", "false"],
      );
    });

    it("raises the sheet after the opening beat, then cycles the category", () => {
      renderScene("switcher");

      const sheet = screen.getByTestId("onboarding-phone-sheet");
      expect(sheet.getAttribute("data-open")).toBe("false");

      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(sheet.getAttribute("data-open")).toBe("true");

      act(() => {
        vi.advanceTimersByTime(1900);
      });
      expect(
        attributes("onboarding-phone-switcher-tab", "data-active"),
      ).toEqual(["false", "true", "false", "false"]);
      expect(texts("onboarding-phone-sheet-row")).toEqual([
        "usage-limits.spec",
        "Grace-period rollout",
        "Risk review",
      ]);
    });

    it("reveals the story beats in script order, then loops", () => {
      renderScene("story");

      // Every beat, in order, attributed to the agent the script names — the
      // phone folds three desktop panes into one column, not into one voice.
      for (let step = 1; step <= LAST_STORY_STEP; step++) {
        advanceStoryBeat(step - 1);
        expect(attributes("onboarding-phone-story-beat", "data-pane")).toEqual(
          storyPanesThrough(step),
        );
        const beats = texts("onboarding-phone-story-beat");
        expect(beats[step]).toContain(STORY_STEPS[step].text);
      }

      // The final beat holds, then the conversation restarts from the top.
      advanceStoryBeat(LAST_STORY_STEP);
      expect(texts("onboarding-phone-story-beat")).toEqual([
        STORY_STEPS[0].text,
      ]);
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      motionState.reducedMotion = true;
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("pins the drawer open on the first frame and stops cycling", () => {
      renderScene("drawer");

      expect(
        screen.getByTestId("onboarding-phone-drawer").getAttribute("data-open"),
      ).toBe("true");

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(
        screen.getByTestId("onboarding-phone-drawer").getAttribute("data-open"),
      ).toBe("true");
      expect(attributes("onboarding-phone-drawer-task", "data-active")).toEqual(
        ["true", "false", "false", "false", "false"],
      );
    });

    it("pins the sheet up on the first frame and stops cycling", () => {
      renderScene("switcher");

      expect(
        screen.getByTestId("onboarding-phone-sheet").getAttribute("data-open"),
      ).toBe("true");

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(
        screen.getByTestId("onboarding-phone-sheet").getAttribute("data-open"),
      ).toBe("true");
      expect(
        attributes("onboarding-phone-switcher-tab", "data-active"),
      ).toEqual(["true", "false", "false", "false"]);
    });

    it("shows the finished conversation and never steps", () => {
      renderScene("story");

      expect(attributes("onboarding-phone-story-beat", "data-pane")).toEqual(
        storyPanesThrough(LAST_STORY_STEP),
      );

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(attributes("onboarding-phone-story-beat", "data-pane")).toEqual(
        storyPanesThrough(LAST_STORY_STEP),
      );
    });
  });
});
