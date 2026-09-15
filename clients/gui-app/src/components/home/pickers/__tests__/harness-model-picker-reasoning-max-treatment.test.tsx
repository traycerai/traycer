import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelOption,
  ReasoningLevelOption,
} from "@/components/home/data/landing-options";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { HarnessModelPickerModelSettingsFooter } from "@/components/home/pickers/harness-model-picker-footers";
import { PortalConcealmentProvider } from "@/components/ui/portal-concealment-context";
import { resetStatusAnimationClockForTests } from "@/lib/animation/status-animation-clock";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// The shared clock is observed through what it actually does - the ONE
// `setInterval` it holds while any writer is subscribed, and the inline style a
// writer leaves on its element - rather than through a mocked
// `subscribeStatusAnimation`. `useStatusAnimation` calls that function through
// the module's own binding, so a mock of the export is never the thing it
// reaches, and a test written against one asserts nothing.

const LEVELS: ReadonlyArray<ReasoningLevelOption> = [
  { id: "off", label: "Off", description: null },
  { id: "low", label: "Low", description: null },
  { id: "high", label: "High", description: null },
  { id: "ultra", label: "Ultra", description: null },
];

// Catalog order is the harness's, and it is not a sort: `ultra` first here, so
// a reading that ranked the ids would call the WRONG stop max.
const UNSORTED_LEVELS: ReadonlyArray<ReasoningLevelOption> = [
  { id: "ultra", label: "Ultra", description: null },
  { id: "low", label: "Low", description: null },
  { id: "high", label: "High", description: null },
];

const TWO_LEVELS: ReadonlyArray<ReasoningLevelOption> = [
  { id: "low", label: "Low", description: null },
  { id: "xhigh", label: "Extra high", description: null },
];

const ONE_LEVEL: ReadonlyArray<ReasoningLevelOption> = [
  { id: "high", label: "High", description: null },
];

const FAST_MODEL: ModelOption = {
  harnessId: "codex",
  slug: "gpt-test",
  label: "GPT Test",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  defaultServiceTier: "standard",
  supportedServiceTiers: [
    { id: "standard", label: "Standard", description: null },
    { id: "fast", label: "Fast", description: null },
  ],
  deprecationNotice: null,
  metadata: {},
};

interface MountOverrides {
  readonly options?: ReadonlyArray<ReasoningLevelOption>;
  readonly value?: string;
  readonly open?: boolean;
  readonly disabled?: boolean;
  readonly serviceTier?: boolean;
  /** The pane this picker lives in is the shown one. */
  readonly paneVisible?: boolean;
  /** The region that rendered the portal is held in a hidden `<Activity>`. */
  readonly concealed?: boolean;
}

interface Mounted {
  readonly selections: Array<string>;
  readonly rerender: (overrides: MountOverrides) => void;
}

function mount(overrides: MountOverrides): Mounted {
  const selections: Array<string> = [];
  // The two providers the popover itself reads before deciding to render its
  // content, so a test can un-present it exactly as the app does.
  const tree = (next: MountOverrides) => (
    <PaneVisibilityContext.Provider value={next.paneVisible ?? true}>
      <PortalConcealmentProvider value={next.concealed ?? false}>
        <HarnessModelPickerModelSettingsFooter
          pickerOpen={next.open ?? true}
          reasoning={{
            value: next.value ?? "low",
            options: next.options ?? LEVELS,
            disabled: next.disabled ?? false,
            onChange: (id) => selections.push(id),
          }}
          serviceTier={
            next.serviceTier === true
              ? { selectedModel: FAST_MODEL, value: "", onChange: () => {} }
              : null
          }
        />
      </PortalConcealmentProvider>
    </PaneVisibilityContext.Provider>
  );
  const view = render(tree(overrides));
  return {
    selections,
    rerender: (next) => view.rerender(tree({ ...overrides, ...next })),
  };
}

function slider(): HTMLElement {
  return screen.getByTestId("model-reasoning-slider");
}

function range(): HTMLElement {
  return screen.getByTestId("model-reasoning-range");
}

function track(): HTMLElement {
  const element = slider().querySelector('[data-slot="slider-track"]');
  if (!(element instanceof HTMLElement)) throw new Error("No track");
  return element;
}

function sparkleField(): HTMLElement | null {
  return screen.queryByTestId("model-reasoning-max-sparkles");
}

function liveSparkleField(): HTMLElement {
  const element = sparkleField();
  if (element === null) throw new Error("Expected a sparkle field");
  return element;
}

function sparkles(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByTestId("model-reasoning-max-sparkle");
}

/**
 * `prefers-reduced-motion` under the test's control, live: the clock reads the
 * media query through `matchMedia` and honours a CHANGE while subscribed, so
 * the stub has to be able to flip and notify rather than answer once.
 */
function stubReducedMotion(initial: boolean): {
  readonly setMatches: (next: boolean) => void;
  readonly fireChange: () => void;
} {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return query === "(prefers-reduced-motion: reduce)" ? matches : false;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.delete(listener);
    },
    dispatchEvent: () => false,
  }));
  return {
    setMatches: (next) => {
      matches = next;
    },
    fireChange: () => {
      for (const listener of listeners) listener();
    },
  };
}

function tick(times: number): void {
  act(() => {
    vi.advanceTimersByTime(40 * times);
  });
}

function withFakeTimers(body: () => void): void {
  vi.useFakeTimers();
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
});

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  resetStatusAnimationClockForTests();
  vi.unstubAllGlobals();
});

describe("reasoning slider max treatment", () => {
  describe("what counts as max", () => {
    it("marks the last catalog stop, whatever the level is called", () => {
      mount({ value: "ultra" });
      expect(slider().getAttribute("data-max")).toBe("true");

      cleanup();
      mount({ options: TWO_LEVELS, value: "xhigh" });
      expect(slider().getAttribute("data-max")).toBe("true");
    });

    it("reads the catalog's order rather than ranking the ids", () => {
      // `ultra` is FIRST in this catalog, so it is the least, not the most.
      mount({ options: UNSORTED_LEVELS, value: "ultra" });
      expect(slider().getAttribute("data-max")).toBeNull();

      cleanup();
      mount({ options: UNSORTED_LEVELS, value: "high" });
      expect(slider().getAttribute("data-max")).toBe("true");
    });

    it("is never max for a zero-effort first stop, a middle stop or an unknown level", () => {
      for (const level of ["off", "low", "not-a-level"]) {
        cleanup();
        mount({ value: level });
        expect(slider().getAttribute("data-max"), level).toBeNull();
        expect(sparkleField(), level).toBeNull();
      }
    });

    it("has no max at all for a one-level catalog or an empty one", () => {
      mount({ options: ONE_LEVEL, value: "high" });
      // One level renders the list, which carries no slider to decorate.
      expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
      expect(sparkleField()).toBeNull();

      cleanup();
      mount({ options: [], value: "", serviceTier: true });
      expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
      expect(sparkleField()).toBeNull();
    });
  });

  describe("the gradient and the glow", () => {
    it("turns the fill into the gradient and lights the pill at max", () => {
      mount({ value: "ultra" });

      expect(range().className).toContain("reasoning-effort-max-range");
      expect(track().className).toContain("reasoning-effort-max-glow");
    });

    it("leaves both off below max, and takes them off when the level drops", () => {
      const { rerender } = mount({ value: "ultra" });
      expect(track().className).toContain("reasoning-effort-max-glow");

      rerender({ value: "high" });

      expect(range().className).not.toContain("reasoning-effort-max-range");
      expect(track().className).not.toContain("reasoning-effort-max-glow");
    });

    // The glow is now a fine 1px edge with no blur to reach past the track,
    // so this padding is no longer glow clearance - it is the slider's own
    // pointer target and focus-ring room around the slimmer pill.
    it("keeps the slider's own padding independent of the footer's row padding", () => {
      mount({ value: "ultra", serviceTier: true });

      expect(slider().className).toContain("py-1");
      // Once, not twice: the footer keeps its own padding whether or not the
      // service-tier row shares the row.
      const footer = slider().closest("div.border-t");
      expect(footer?.className).toContain("py-1.5");
      expect(footer?.className).not.toMatch(/\bpy-2\b/);
    });

    it("leaves the list's own height alone", () => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: "list",
        },
      });
      mount({ value: "ultra" });

      const footer = screen
        .getByTestId("model-reasoning-scroller")
        .closest("div.border-t");
      expect(footer?.className).toContain("py-1.5");
    });
  });

  describe("the sparkle field", () => {
    it("renders the whole constellation while max is selected, including a picker opened at max", () => {
      withFakeTimers(() => {
        mount({ value: "ultra" });

        expect(sparkles()).toHaveLength(11);
        // Subscribed and already written, before the first tick.
        expect(
          liveSparkleField().style.getPropertyValue("--reasoning-sparkle-0"),
        ).not.toBe("");
        expect(vi.getTimerCount()).toBeGreaterThan(0);
      });
    });

    it("is absent below max, and leaves with the selection", () => {
      withFakeTimers(() => {
        const { rerender } = mount({ value: "low" });
        expect(sparkleField()).toBeNull();
        // Nothing at all runs for a level that is not the top one.
        expect(vi.getTimerCount()).toBe(0);

        rerender({ value: "ultra" });
        expect(sparkleField()).not.toBeNull();

        rerender({ value: "high" });
        expect(sparkleField()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("stops for a closed picker, a defocused pane, concealment and disablement", () => {
      const cases: ReadonlyArray<MountOverrides> = [
        { open: false },
        { paneVisible: false },
        { concealed: true },
        { disabled: true },
      ];
      for (const gate of cases) {
        cleanup();
        const { rerender } = mount({ value: "ultra" });
        expect(sparkleField(), JSON.stringify(gate)).not.toBeNull();

        rerender(gate);
        expect(sparkleField(), JSON.stringify(gate)).toBeNull();

        // And it comes back when the gate does: the field is a state, not a
        // one-shot that a closed gate spends.
        rerender({
          open: true,
          paneVisible: true,
          concealed: false,
          disabled: false,
        });
        expect(sparkleField(), JSON.stringify(gate)).not.toBeNull();
      }
    });

    it("draws nothing under the list control", () => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: "list",
        },
      });
      withFakeTimers(() => {
        mount({ value: "ultra" });

        expect(sparkleField()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("twinkles each sparkle on its own phase, and never runs an animation", () => {
      withFakeTimers(() => {
        mount({ value: "ultra" });
        const field = liveSparkleField();

        const readAll = (): ReadonlyArray<number> =>
          sparkles().map((_, index) =>
            Number(
              field.style.getPropertyValue(`--reasoning-sparkle-${index}`),
            ),
          );

        const first = readAll();
        expect(first).toHaveLength(11);
        // Authored phases, so no two start together - a field that pulsed in
        // unison would read as the whole fill blinking.
        expect(new Set(first).size).toBeGreaterThan(5);
        for (const opacity of first) {
          expect(opacity).toBeGreaterThanOrEqual(0.25);
          expect(opacity).toBeLessThanOrEqual(1);
        }

        // The smooth cadence (every 40ms tick, not every other one): both of
        // the next two ticks write a new frame.
        tick(1);
        const afterOneTick = readAll();
        expect(afterOneTick).not.toEqual(first);
        tick(1);
        expect(readAll()).not.toEqual(afterOneTick);

        // 2400ms is one full period; 60 ticks (all of them writing now) land
        // back on the values the field opened with.
        tick(58);
        expect(readAll()).toEqual(first);
        for (const sparkle of sparkles()) {
          expect(sparkle.style.animation).toBe("");
        }
      });
    });

    it("leaves no inline property behind when it stops", () => {
      withFakeTimers(() => {
        const { rerender } = mount({ value: "ultra" });
        const field = liveSparkleField();
        tick(4);
        expect(field.getAttribute("style")).not.toBe("");

        rerender({ value: "high" });

        expect(sparkleField()).toBeNull();
        expect(field.getAttribute("style")).toBe("");
      });
    });

    it("unsubscribes from the shared clock, stopping it when it was the only writer", () => {
      withFakeTimers(() => {
        const { rerender } = mount({ value: "ultra" });
        tick(2);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        rerender({ open: false });

        // Not merely hidden: the writer is gone, and with no writer left the
        // shared interval stops rather than ticking against a popover nobody
        // can see.
        expect(sparkleField()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("keeps the field, static and unsubscribed, under reduced motion", () => {
      stubReducedMotion(true);
      withFakeTimers(() => {
        mount({ value: "ultra" });

        // Present, so the level still reads as the top one; still, because no
        // writer ever touched it and each `opacity` falls back to its own
        // literal.
        expect(sparkles()).toHaveLength(11);
        expect(vi.getTimerCount()).toBe(0);
        const field = liveSparkleField();
        expect(field.style.getPropertyValue("--reasoning-sparkle-0")).toBe("");
        for (const sparkle of sparkles()) {
          expect(sparkle.style.opacity).toContain("0.6");
        }
        // The still half of the treatment is exactly what it keeps.
        expect(range().className).toContain("reasoning-effort-max-range");
        expect(track().className).toContain("reasoning-effort-max-glow");
      });
    });

    it("stops twinkling the moment the preference turns on, and resumes when it turns off", () => {
      const media = stubReducedMotion(false);
      mount({ value: "ultra" });
      const field = liveSparkleField();
      expect(field.style.getPropertyValue("--reasoning-sparkle-0")).not.toBe(
        "",
      );

      act(() => {
        media.setMatches(true);
        media.fireChange();
      });
      expect(sparkleField()).not.toBeNull();
      expect(field.style.getPropertyValue("--reasoning-sparkle-0")).toBe("");

      act(() => {
        media.setMatches(false);
        media.fireChange();
      });
      expect(
        liveSparkleField().style.getPropertyValue("--reasoning-sparkle-0"),
      ).not.toBe("");
    });

    it("costs one interval and no animation frames", () => {
      const setInterval = vi.spyOn(window, "setInterval");
      const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame");
      try {
        mount({ value: "ultra" });

        expect(requestAnimationFrame).not.toHaveBeenCalled();
        // One interval for the whole app's clock, not one per sparkle.
        expect(setInterval.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        setInterval.mockRestore();
        requestAnimationFrame.mockRestore();
      }
    });
  });

  it("keeps every decoration out of the accessibility tree and the tab order", () => {
    mount({ value: "ultra" });

    for (const decoration of [liveSparkleField(), ...sparkles()]) {
      expect(decoration.getAttribute("aria-hidden")).toBe("true");
      expect(decoration.getAttribute("tabindex")).toBeNull();
      expect(decoration.getAttribute("role")).toBeNull();
    }
    expect(screen.getAllByRole("slider")).toHaveLength(1);
    expect(
      screen
        .getByRole("slider", { name: "Thinking effort" })
        .className.includes("focus-visible:ring-2"),
    ).toBe(true);
  });

  // Everything the earlier max flourish drew is gone, not merely unused: a
  // marker left behind is a class someone restyles into a second treatment.
  it("leaves none of the retired bloom, tail or flow markers behind", () => {
    mount({ value: "ultra" });

    for (const testId of [
      "model-reasoning-max-bloom",
      "model-reasoning-max-tail",
      "model-reasoning-max-flow",
      "model-reasoning-thumb-core",
    ]) {
      expect(screen.queryByTestId(testId), testId).toBeNull();
    }
    expect(slider().getAttribute("data-open")).toBeNull();
    expect(document.body.innerHTML).not.toContain("reasoning-effort-bloom");
    expect(document.body.innerHTML).not.toContain("reasoning-effort-max-tail");
    expect(document.body.innerHTML).not.toContain("reasoning-effort-max-flow");
  });
});
