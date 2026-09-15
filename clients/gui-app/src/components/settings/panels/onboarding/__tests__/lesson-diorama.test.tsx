import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import {
  LessonDiorama,
  type LessonDioramaScene,
} from "@/components/settings/panels/onboarding/lesson-diorama";
import {
  NAVIGATION_PHASE_MS,
  OPENCODE_RUN_LABEL,
  TASKS,
  TASK_SCENES,
  TASK_TAB_CYCLE_MS,
} from "@/components/settings/panels/onboarding/lesson-diorama-shared";

/**
 * `useReducedMotion` memoises the media-query answer in a module-level ref
 * the first time any component calls it, so a `matchMedia` stub can only
 * decide the answer once per file. Driving the hook itself — the same
 * pattern `onboarding-phone-diorama.test.tsx` uses — keeps both arms,
 * animated and reduced, in one suite.
 */
const motionState = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => motionState.reducedMotion };
});

/**
 * The diorama reaches nothing real — no host, no tab store, no terminal
 * runtime — so rendering it under `LazyMotion` alone, with no router, no
 * query client and no host provider, is itself part of what this suite
 * proves: the miniature has no hidden dependency on the app shell.
 */
function renderScene(scene: LessonDioramaScene) {
  return render(
    <LazyMotion features={domAnimation}>
      <LessonDiorama scene={scene} />
    </LazyMotion>,
  );
}

function activeTabText(): string {
  const active = screen
    .getAllByTestId("lesson-diorama-task-tab")
    .find((tab) => tab.hasAttribute("data-active"));
  return active === undefined ? "" : active.textContent;
}

function splitPaneHarnesses(): ReadonlyArray<string> {
  return screen
    .queryAllByTestId("lesson-diorama-split-pane")
    .map((pane) => pane.getAttribute("data-harness") ?? "");
}

// `vi.getTimerCount()` only proves nothing was left running after unmount or
// a scene switch — it says nothing about whether the right thing happened
// while the timer was alive. Every timer-driven test below also asserts the
// visible DOM state; a bare `getTimerCount()` check is reserved for the
// cleanup-only tests (unmount, scene switch, reduced motion).
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("LessonDiorama", () => {
  beforeEach(() => {
    motionState.reducedMotion = false;
    // Only the timers the diorama itself schedules. Vitest 4 fakes
    // `requestAnimationFrame` by default, and motion's frameloop runs on it,
    // so a pane's entry fade or the drag pill would otherwise show up in
    // `getTimerCount()` and make the cleanup assertions about the wrong thing.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe("task-tabs scene", () => {
    it("mounts on task 0 and cycles through every task, wrapping back to 0", () => {
      renderScene("task-tabs");
      const sidebar = screen.getByTestId("lesson-diorama-sidebar");

      expect(activeTabText()).toBe(TASKS[0]);
      expect(within(sidebar).getByText(TASK_SCENES[0].chat)).toBeTruthy();
      expect(within(sidebar).getByText(TASK_SCENES[0].spec)).toBeTruthy();
      expect(screen.getByTestId("lesson-diorama-chat-sample").textContent).toBe(
        "Continue team usage limits",
      );

      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[1]);
      expect(within(sidebar).getByText(TASK_SCENES[1].chat)).toBeTruthy();
      expect(within(sidebar).getByText(TASK_SCENES[1].spec)).toBeTruthy();
      expect(within(sidebar).queryByText(TASK_SCENES[0].chat)).toBeNull();
      expect(screen.getByTestId("lesson-diorama-chat-sample").textContent).toBe(
        "Continue billing service",
      );

      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[2]);

      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[0]);
    });

    it("pause freezes the active task; play resumes the cycle", () => {
      renderScene("task-tabs");
      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[1]);

      fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
      advance(TASK_TAB_CYCLE_MS * 3);
      expect(activeTabText()).toBe(TASKS[1]);
      expect(screen.getByRole("button", { name: "Play demo" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Play demo" }));
      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[2]);
    });

    it("clears the tab-cycle interval on unmount", () => {
      const { unmount } = renderScene("task-tabs");
      unmount();
      expect(() => advance(5000)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the tab interval when the scene switches away from task-tabs", () => {
      const { rerender } = renderScene("task-tabs");
      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[1]);

      rerender(
        <LazyMotion features={domAnimation}>
          <LessonDiorama scene="split-screen" />
        </LazyMotion>,
      );

      expect(
        screen.getByTestId("lesson-diorama-frame").getAttribute("data-scene"),
      ).toBe("split-screen");
      // The scene switch remounts the player (`key={scene}`), so the old
      // task-tab interval is torn down and exactly the new player's own
      // navigation-phase timeout is scheduled — never both at once, and
      // never zero.
      expect(vi.getTimerCount()).toBe(1);

      advance(TASK_TAB_CYCLE_MS * 3);
      expect(activeTabText()).toBe(TASKS[0]);
    });
  });

  describe("split-screen scene", () => {
    it("cycles single → drag-1 → split-1 → drag-2 → split-2 → single", () => {
      renderScene("split-screen");
      const frame = screen.getByTestId("lesson-diorama-frame");

      expect(frame.getAttribute("data-phase")).toBe("single");
      expect(splitPaneHarnesses()).toEqual([]);

      advance(NAVIGATION_PHASE_MS["single"]);
      expect(frame.getAttribute("data-phase")).toBe("drag-1");
      expect(screen.getByTestId("lesson-diorama-drag-pill")).toBeTruthy();
      expect(
        screen.getByTestId("lesson-diorama-drop-zone").textContent,
      ).toContain("Drop to split right");

      advance(NAVIGATION_PHASE_MS["drag-1"]);
      expect(frame.getAttribute("data-phase")).toBe("split-1");
      expect(splitPaneHarnesses()).toEqual(["claude"]);
      expect(screen.queryByTestId("lesson-diorama-drag-pill")).toBeNull();
      const claudePane = screen.getByTestId("lesson-diorama-split-pane");
      expect(
        within(claudePane).getByText(TASK_SCENES[0].terminal),
      ).toBeTruthy();

      advance(NAVIGATION_PHASE_MS["split-1"]);
      expect(frame.getAttribute("data-phase")).toBe("drag-2");
      expect(screen.getByTestId("lesson-diorama-drag-pill")).toBeTruthy();
      expect(
        screen.getByTestId("lesson-diorama-drop-zone").textContent,
      ).toContain("Drop to split below");
      expect(splitPaneHarnesses()).toEqual(["claude"]);

      advance(NAVIGATION_PHASE_MS["drag-2"]);
      expect(frame.getAttribute("data-phase")).toBe("split-2");
      expect(splitPaneHarnesses()).toEqual(["claude", "opencode"]);
      const opencodePane = screen.getAllByTestId(
        "lesson-diorama-split-pane",
      )[1];
      expect(within(opencodePane).getByText(OPENCODE_RUN_LABEL)).toBeTruthy();

      advance(NAVIGATION_PHASE_MS["split-2"]);
      expect(frame.getAttribute("data-phase")).toBe("single");
      expect(splitPaneHarnesses()).toEqual([]);
    });

    it("pause freezes the phase mid-cycle; play resumes it", () => {
      renderScene("split-screen");
      // One advance per phase: the next phase's timeout is scheduled by an
      // effect that only runs once `act` flushes the previous tick.
      advance(NAVIGATION_PHASE_MS["single"]);
      advance(NAVIGATION_PHASE_MS["drag-1"]);
      const frame = screen.getByTestId("lesson-diorama-frame");
      expect(frame.getAttribute("data-phase")).toBe("split-1");

      fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
      advance(10000);
      expect(frame.getAttribute("data-phase")).toBe("split-1");
      expect(splitPaneHarnesses()).toEqual(["claude"]);

      fireEvent.click(screen.getByRole("button", { name: "Play demo" }));
      advance(NAVIGATION_PHASE_MS["split-1"]);
      expect(frame.getAttribute("data-phase")).toBe("drag-2");
    });

    it("pause mid-drag stills the drag beat; play replays it from the start", () => {
      renderScene("split-screen");
      advance(NAVIGATION_PHASE_MS["single"]);
      const frame = screen.getByTestId("lesson-diorama-frame");
      expect(frame.getAttribute("data-phase")).toBe("drag-1");
      expect(
        screen
          .getByTestId("lesson-diorama-drag-pill")
          .hasAttribute("data-paused"),
      ).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
      // The phase clock is stopped AND the Motion-driven pill and drop zone
      // are rendered as a still: parked on the row, zone lit. Without the
      // second half the pill would finish its journey under "Play demo".
      advance(10000);
      expect(frame.getAttribute("data-phase")).toBe("drag-1");
      expect(
        screen
          .getByTestId("lesson-diorama-drag-pill")
          .hasAttribute("data-paused"),
      ).toBe(true);
      expect(
        screen
          .getByTestId("lesson-diorama-drop-zone")
          .hasAttribute("data-paused"),
      ).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.click(screen.getByRole("button", { name: "Play demo" }));
      expect(
        screen
          .getByTestId("lesson-diorama-drag-pill")
          .hasAttribute("data-paused"),
      ).toBe(false);
      // The beat restarts with the phase's full duration, not the remainder.
      advance(NAVIGATION_PHASE_MS["drag-1"] - 1);
      expect(frame.getAttribute("data-phase")).toBe("drag-1");
      advance(1);
      expect(frame.getAttribute("data-phase")).toBe("split-1");
      expect(splitPaneHarnesses()).toEqual(["claude"]);
    });

    it("clears the phase timeout on unmount mid-drag", () => {
      const { unmount } = renderScene("split-screen");
      advance(NAVIGATION_PHASE_MS["single"]);
      expect(
        screen.getByTestId("lesson-diorama-frame").getAttribute("data-phase"),
      ).toBe("drag-1");

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      motionState.reducedMotion = true;
    });

    it("task-tabs: settles on task 0 with no timers and no pause control", () => {
      renderScene("task-tabs");
      const frame = screen.getByTestId("lesson-diorama-frame");

      expect(activeTabText()).toBe(TASKS[0]);
      expect(frame.hasAttribute("data-reduced-motion")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      advance(10000);
      expect(activeTabText()).toBe(TASKS[0]);
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("split-screen: mounts at the finished split with no drag chrome and no timers", () => {
      renderScene("split-screen");
      const frame = screen.getByTestId("lesson-diorama-frame");

      expect(frame.getAttribute("data-phase")).toBe("split-2");
      expect(splitPaneHarnesses()).toEqual(["claude", "opencode"]);
      expect(screen.queryByTestId("lesson-diorama-drag-pill")).toBeNull();
      expect(screen.queryByTestId("lesson-diorama-drop-zone")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(frame.className).not.toContain("transition-");
    });
  });

  describe("reduced motion changing while mounted", () => {
    const originalMatchMedia = window.matchMedia;
    afterEach(() => {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    });

    /**
     * Motion's `useReducedMotion` is the initial read only, so the component
     * subscribes to the media query itself. This stub is what lets the test
     * fire a real `change` event at that subscription after mount.
     */
    function installMatchMediaStub(): (matches: boolean) => void {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const list = {
        matches: false,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: (
          _type: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => {
          listeners.add(listener);
        },
        removeEventListener: (
          _type: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => {
          listeners.delete(listener);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: () => list,
      });
      return (matches: boolean) => {
        list.matches = matches;
        const event = { matches, media: list.media } as MediaQueryListEvent;
        act(() => {
          for (const listener of listeners) listener(event);
        });
      };
    }

    it("task-tabs: a live switch to reduced motion settles on task 0 and stops the cycle", () => {
      const setReducedMotion = installMatchMediaStub();
      renderScene("task-tabs");
      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[1]);

      setReducedMotion(true);
      const frame = screen.getByTestId("lesson-diorama-frame");
      expect(frame.hasAttribute("data-reduced-motion")).toBe(true);
      expect(activeTabText()).toBe(TASKS[0]);
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.queryByRole("button")).toBeNull();
      advance(TASK_TAB_CYCLE_MS * 3);
      expect(activeTabText()).toBe(TASKS[0]);

      // And back: the cycle restarts from its first beat.
      setReducedMotion(false);
      expect(frame.hasAttribute("data-reduced-motion")).toBe(false);
      expect(screen.getByRole("button", { name: "Pause demo" })).toBeTruthy();
      advance(TASK_TAB_CYCLE_MS);
      expect(activeTabText()).toBe(TASKS[1]);
    });

    it("split-screen: a live switch to reduced motion settles on the finished split mid-drag", () => {
      const setReducedMotion = installMatchMediaStub();
      renderScene("split-screen");
      advance(NAVIGATION_PHASE_MS["single"]);
      const frame = screen.getByTestId("lesson-diorama-frame");
      expect(frame.getAttribute("data-phase")).toBe("drag-1");
      expect(screen.getByTestId("lesson-diorama-drag-pill")).toBeTruthy();

      setReducedMotion(true);
      expect(frame.getAttribute("data-phase")).toBe("split-2");
      expect(splitPaneHarnesses()).toEqual(["claude", "opencode"]);
      expect(screen.queryByTestId("lesson-diorama-drag-pill")).toBeNull();
      expect(screen.queryByTestId("lesson-diorama-drop-zone")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(frame.className).not.toContain("transition-");
    });
  });

  describe("accessibility", () => {
    const CASES: ReadonlyArray<readonly [LessonDioramaScene, string, string]> =
      [
        ["task-tabs", "sidebar", "canvas"],
        ["split-screen", "right edge", "below"],
      ];

    it.each(CASES)(
      "keeps the frame inert and hidden, with the caption and pause control reachable outside it (%s)",
      (scene, phraseA, phraseB) => {
        renderScene(scene);
        const frame = screen.getByTestId("lesson-diorama-frame");
        expect(frame.hasAttribute("inert")).toBe(true);
        expect(frame.getAttribute("aria-hidden")).toBe("true");

        const caption = screen.getByTestId("lesson-diorama-caption");
        expect(caption.textContent).toContain(phraseA);
        expect(caption.textContent).toContain(phraseB);
        expect(frame.contains(caption)).toBe(false);

        // `getAllByRole` excludes `aria-hidden` content by default, so the
        // pause button only turns up here because it truly sits outside the
        // inert frame — not because the query missed it.
        const button = screen.getByRole("button", { name: "Pause demo" });
        expect(frame.contains(button)).toBe(false);
        expect(screen.getAllByRole("button")).toHaveLength(1);

        // And the fake chrome inside the frame has no button-like element at
        // all — `hidden: true` bypasses the aria-hidden exclusion above, so
        // this proves absence rather than the query's default filtering.
        expect(
          within(frame).queryAllByRole("button", { hidden: true }),
        ).toEqual([]);
      },
    );
  });
});
