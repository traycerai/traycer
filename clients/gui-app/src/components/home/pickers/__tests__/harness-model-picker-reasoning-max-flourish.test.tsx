import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelOption,
  ReasoningLevelOption,
} from "@/components/home/data/landing-options";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { HarnessModelPickerModelSettingsFooter } from "@/components/home/pickers/harness-model-picker-footers";
import { PortalConcealmentProvider } from "@/components/ui/portal-concealment-context";
import {
  stopX,
  stubSliderGeometry,
} from "@/components/home/pickers/__tests__/slider-pointer-geometry";
import { useReasoningMaxCue } from "@/components/home/pickers/use-reasoning-max-cue";
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

/**
 * A seam onto the mounted harness, so a test can do the three things a user
 * cannot: change the level the way an external store would, replay the ⌥-digit
 * path directly, and report a cue finished by generation number.
 *
 * Module-level rather than a prop, because a component may not write to what it
 * is handed.
 */
interface Seam {
  readonly setValue: (next: string) => void;
  readonly change: (next: string) => void;
  readonly endCue: (generation: number) => void;
}

let seam: Seam | null = null;

function liveSeam(): Seam {
  if (seam === null) throw new Error("Nothing mounted");
  return seam;
}

interface HarnessProps {
  readonly options: ReadonlyArray<ReasoningLevelOption>;
  readonly initial: string;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly modelSlug: string;
  readonly hostId: string;
  readonly serviceTier: boolean;
  /** The pane this picker lives in is the shown one. */
  readonly paneVisible: boolean;
  /** The region that rendered the portal is held in a hidden `<Activity>`. */
  readonly concealed: boolean;
  /**
   * Whether the popover's CONTENT is mounted. False stands for the portal
   * un-presenting while the picker's root stays open.
   */
  readonly contentMounted: boolean;
  readonly onSelect: (next: string) => void;
}

/**
 * The picker's own wiring, minus the picker: the real cue hook feeding the
 * real footer, with the level held in state exactly as the composer store
 * holds it. Both halves are the shipped ones - only the surrounding picker is
 * stood in for.
 */
function CueHarness(props: HarnessProps) {
  const [value, setValue] = useState(props.initial);
  const { config, onChange } = useReasoningMaxCue({
    value,
    options: props.options,
    disabled: props.disabled,
    open: props.open,
    hostId: props.hostId,
    harnessId: "codex",
    modelSlug: props.modelSlug,
    onSelect: (next) => {
      props.onSelect(next);
      setValue(next);
    },
  });
  const onCueEnd = config.onCueEnd;
  useEffect(() => {
    seam = { setValue, change: onChange, endCue: onCueEnd };
  }, [onChange, onCueEnd]);
  if (!props.contentMounted) return null;
  return (
    <HarnessModelPickerModelSettingsFooter
      reasoning={{
        value,
        options: props.options,
        disabled: props.disabled,
        onChange,
      }}
      reasoningMax={config}
      serviceTier={
        props.serviceTier
          ? { selectedModel: FAST_MODEL, value: "", onChange: () => {} }
          : null
      }
    />
  );
}

interface MountOverrides {
  readonly options?: ReadonlyArray<ReasoningLevelOption>;
  readonly initial?: string;
  readonly open?: boolean;
  readonly disabled?: boolean;
  readonly modelSlug?: string;
  readonly hostId?: string;
  readonly serviceTier?: boolean;
  readonly paneVisible?: boolean;
  readonly concealed?: boolean;
  readonly contentMounted?: boolean;
}

interface Mounted {
  readonly selections: Array<string>;
  readonly rerender: (overrides: MountOverrides) => void;
}

function mount(overrides: MountOverrides): Mounted {
  const selections: Array<string> = [];
  const propsFor = (next: MountOverrides): HarnessProps => ({
    options: next.options ?? LEVELS,
    initial: next.initial ?? "low",
    open: next.open ?? true,
    disabled: next.disabled ?? false,
    modelSlug: next.modelSlug ?? "gpt-5.5",
    hostId: next.hostId ?? "host-a",
    serviceTier: next.serviceTier ?? false,
    paneVisible: next.paneVisible ?? true,
    concealed: next.concealed ?? false,
    contentMounted: next.contentMounted ?? true,
    onSelect: (id) => selections.push(id),
  });
  // The two providers the popover itself reads before deciding to render its
  // content, so a test can un-present it exactly as the app does.
  const tree = (next: MountOverrides) => {
    const harnessProps = propsFor(next);
    return (
      <PaneVisibilityContext.Provider value={harnessProps.paneVisible}>
        <PortalConcealmentProvider value={harnessProps.concealed}>
          <CueHarness {...harnessProps} />
        </PortalConcealmentProvider>
      </PaneVisibilityContext.Provider>
    );
  };
  const view = render(tree(overrides));
  return {
    selections,
    rerender: (next) => view.rerender(tree({ ...overrides, ...next })),
  };
}

function slider(): HTMLElement {
  return screen.getByTestId("model-reasoning-slider");
}

function bloom(): HTMLElement | null {
  return screen.queryByTestId("model-reasoning-max-bloom");
}

function thumb(): HTMLElement {
  return screen.getByRole("slider", { name: "Thinking effort" });
}

/**
 * An `animationend` React will actually hear, carrying a name.
 *
 * jsdom has no global `AnimationEvent`, so React's vendor-prefix probe lands on
 * `webkitAnimationEnd` and `fireEvent.animationEnd` is swallowed - the same
 * trap `chat-dock-compact-chip.test.tsx` documents. The name has to be an own
 * property of the native event, because that is where React's synthetic
 * `animationName` is read from.
 */
function fireAnimationEnd(element: Element, animationName: string): void {
  const event = new Event("webkitAnimationEnd", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "animationName", { value: animationName });
  fireEvent(element, event);
}

/** The animation the CSS actually runs, ended the way the browser ends it. */
function endBloom(element: HTMLElement): void {
  fireAnimationEnd(element, "reasoning-max-bloom");
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

/** Every user route ends here, which is the point of the acknowledgement path. */
function select(...ids: ReadonlyArray<string>): void {
  act(() => {
    for (const id of ids) liveSeam().change(id);
  });
}

beforeEach(() => {
  seam = null;
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
});

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  resetStatusAnimationClockForTests();
  vi.unstubAllGlobals();
});

describe("reasoning max-effort flourish", () => {
  describe("what counts as max", () => {
    it("marks the last catalog stop, whatever the level is called", () => {
      mount({ initial: "ultra" });
      expect(slider().getAttribute("data-max")).toBe("true");

      cleanup();
      mount({ options: TWO_LEVELS, initial: "xhigh" });
      expect(slider().getAttribute("data-max")).toBe("true");
    });

    it("reads the catalog's order rather than ranking the ids", () => {
      // `ultra` is FIRST in this catalog, so it is the least, not the most.
      mount({ options: UNSORTED_LEVELS, initial: "ultra" });
      expect(slider().getAttribute("data-max")).toBeNull();

      cleanup();
      mount({ options: UNSORTED_LEVELS, initial: "high" });
      expect(slider().getAttribute("data-max")).toBe("true");
    });

    it("is never max for a zero-effort first stop, a middle stop or an unknown level", () => {
      for (const level of ["off", "low", "not-a-level"]) {
        cleanup();
        mount({ initial: level });
        expect(slider().getAttribute("data-max"), level).toBeNull();
        expect(bloom()).toBeNull();
      }
    });

    it("has no max at all for a one-level catalog or an empty one", () => {
      mount({ options: ONE_LEVEL, initial: "high" });
      // One level renders the list, which carries no slider to decorate.
      expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
      expect(screen.queryByTestId("model-reasoning-max-tail")).toBeNull();

      cleanup();
      mount({ options: [], initial: "", serviceTier: true });
      expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
      expect(bloom()).toBeNull();
    });

    it("decorates nothing, and creates no cue, under the list control", () => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: "list",
        },
      });
      const { selections } = mount({ initial: "low" });

      select("ultra");

      expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
      expect(bloom()).toBeNull();
      // The level still changes: the flourish is the only thing withheld.
      expect(selections).toEqual(["ultra"]);
    });
  });

  describe("arriving at max", () => {
    it("opens at max static, with no pulse node", () => {
      mount({ initial: "ultra" });

      expect(slider().getAttribute("data-max")).toBe("true");
      expect(slider().getAttribute("data-open")).toBe("true");
      expect(bloom()).toBeNull();
      expect(thumb().getAttribute("aria-valuetext")).toBe("Ultra");
      expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
        "Ultra",
      );
    });

    it("stays static when the picker closes and reopens at max", () => {
      const { rerender } = mount({ initial: "ultra" });

      rerender({ open: false });
      rerender({ open: true });

      expect(slider().getAttribute("data-max")).toBe("true");
      expect(bloom()).toBeNull();
    });

    it("blooms once when a stop click moves the selection to max", () => {
      const { selections } = mount({ initial: "low" });

      fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));

      expect(bloom()).not.toBeNull();
      expect(bloom()?.getAttribute("data-pulse")).toBe("true");
      // The setter still receives the catalog id, and only that.
      expect(selections).toEqual(["ultra"]);
    });

    it("blooms once for End, and not again for a repeat at the endpoint", () => {
      mount({ initial: "low" });

      fireEvent.keyDown(thumb(), { key: "End" });
      const first = bloom();
      expect(first).not.toBeNull();

      fireEvent.keyDown(thumb(), { key: "End" });
      fireEvent.keyDown(thumb(), { key: "ArrowRight" });

      expect(bloom()).toBe(first);
    });

    it("blooms once for a real drag that crosses the endpoint and keeps going", () => {
      // The actual Radix gesture, not the callback behind it: every step the
      // drag crosses is reported, and the endpoint more than once as the
      // pointer keeps moving past it.
      const restore = stubSliderGeometry();
      try {
        const { selections } = mount({ initial: "off" });
        const start = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(start, { pointerId: 1, clientX: 0, button: 0 });
        fireEvent.pointerMove(start, { pointerId: 1, clientX: stopX(2, 4) });
        fireEvent.pointerMove(start, { pointerId: 1, clientX: stopX(3, 4) });
        fireEvent.pointerMove(start, { pointerId: 1, clientX: 520 });
        fireEvent.pointerUp(start, { pointerId: 1, clientX: 520 });
        fireEvent.click(start);

        expect(screen.getAllByTestId("model-reasoning-max-bloom")).toHaveLength(
          1,
        );
        expect(selections.at(-1)).toBe("ultra");
        expect(slider().getAttribute("data-max")).toBe("true");
      } finally {
        restore();
      }
    });

    it("does not celebrate a level that no catalog level was left for", () => {
      // A remembered level from another model, before normalization catches up:
      // the user did not climb off a rung, so landing on max is a correction.
      const { selections } = mount({ initial: "not-a-level" });

      select("ultra");

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");
      expect(selections).toEqual(["ultra"]);

      // And the guard is about THAT change only - the next real one blooms.
      select("low");
      select("ultra");
      expect(bloom()).not.toBeNull();
    });

    // The ⌥-digit chord's own route - the leader scope calling
    // `ReasoningFooterConfig.onChange` without touching the slider - is covered
    // end to end in `home/__tests__/harness-model-picker.test.tsx`, where the
    // real picker registers the real scope.
  });

  describe("retiring the cue", () => {
    it("retires its own bloom when that animation ends, leaving max intact", () => {
      mount({ initial: "low" });
      fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));
      const pulse = bloom();
      if (pulse === null) throw new Error("Expected a bloom");

      endBloom(pulse);

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");
      expect(thumb().getAttribute("aria-valuenow")).toBe("3");
      expect(thumb().getAttribute("aria-valuetext")).toBe("Ultra");
      expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
        "Ultra",
      );
    });

    it("ignores an animation end that is not its own", () => {
      mount({ initial: "low" });
      fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));
      const pulse = bloom();
      if (pulse === null) throw new Error("Expected a bloom");

      // The same element finishing some other animation, and the bloom's own
      // animation name ending somewhere else - a popover or a tooltip playing
      // out around it. Neither is this cue finishing.
      fireAnimationEnd(pulse, "popover-exit");
      fireAnimationEnd(slider(), "reasoning-max-bloom");

      // And the same name BUBBLING out of a descendant, which reaches the
      // handler with a `target` that is not its `currentTarget`. The bloom has
      // no children of its own, so the test gives it one.
      const child = document.createElement("span");
      pulse.appendChild(child);
      fireAnimationEnd(child, "reasoning-max-bloom");

      expect(bloom()).toBe(pulse);
    });

    it("cannot be retired by a stale generation", () => {
      mount({ initial: "low" });
      select("ultra");
      select("low");
      select("ultra");
      const second = bloom();
      expect(second).not.toBeNull();

      // The first cue's animation, finishing late.
      act(() => liveSeam().endCue(1));

      expect(bloom()).toBe(second);
    });

    it("drops the cue and the max treatment the moment the selection leaves max", () => {
      mount({ initial: "low" });
      select("ultra");
      expect(bloom()).not.toBeNull();

      select("high");

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBeNull();
    });

    it("starts a fresh generation on return, without remounting or blurring the thumb", () => {
      mount({ initial: "low" });
      const focused = thumb();
      focused.focus();
      select("ultra");
      const first = bloom();

      select("low");
      select("ultra");

      const second = bloom();
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      expect(thumb()).toBe(focused);
      expect(document.activeElement).toBe(focused);
    });
  });

  describe("gates", () => {
    it("removes the bloom the moment the picker closes, content still mounted", () => {
      // The popover keeps its content for the exit animation, so the footer is
      // still on screen with `open` already false.
      const { rerender } = mount({ initial: "low" });
      select("ultra");
      expect(bloom()).not.toBeNull();

      rerender({ open: false });

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-open")).toBeNull();

      rerender({ open: true });
      expect(bloom()).toBeNull();
    });

    it("drops the cue when the pane loses focus, and does not replay it on the way back", () => {
      // `PopoverContent` un-presents on pane focus loss while the picker's root
      // stays OPEN, so `open` alone never sees this. The content unmounting is
      // the whole event: the cue lives above the portal and would otherwise be
      // waiting when the pane returns.
      const { rerender } = mount({ initial: "low" });
      select("ultra");
      expect(bloom()).not.toBeNull();

      rerender({ paneVisible: false, contentMounted: false });
      rerender({ paneVisible: true, contentMounted: true });

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");
      expect(thumb().getAttribute("aria-valuetext")).toBe("Ultra");
    });

    it("drops the cue when the region that rendered the portal is concealed", () => {
      const { rerender } = mount({ initial: "low" });
      select("ultra");
      expect(bloom()).not.toBeNull();

      rerender({ concealed: true, contentMounted: false });
      rerender({ concealed: false, contentMounted: true });

      expect(bloom()).toBeNull();
    });

    it("refuses to capture a cue while the content is not presented", () => {
      const { rerender } = mount({ initial: "low", paneVisible: false });

      select("ultra");
      rerender({ paneVisible: true });

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");
    });

    it("does not resurrect a cue after a disable or a list round trip", () => {
      const { rerender } = mount({ initial: "low" });
      select("ultra");

      rerender({ disabled: true });
      expect(bloom()).toBeNull();
      rerender({ disabled: false });
      expect(bloom()).toBeNull();

      select("low");
      select("ultra");
      expect(bloom()).not.toBeNull();
      act(() => {
        useLayoutStore.getState().setComposerReasoningFooterControl("list");
      });
      expect(bloom()).toBeNull();
      act(() => {
        useLayoutStore.getState().setComposerReasoningFooterControl("slider");
      });
      expect(bloom()).toBeNull();
    });

    it("cancels the cue when the model, host or catalog changes under it", () => {
      const { rerender } = mount({ initial: "low" });
      select("ultra");
      expect(bloom()).not.toBeNull();

      rerender({ modelSlug: "gpt-6" });
      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");

      select("low");
      select("ultra");
      expect(bloom()).not.toBeNull();
      rerender({ hostId: "host-b" });
      expect(bloom()).toBeNull();

      select("low");
      select("ultra");
      expect(bloom()).not.toBeNull();
      rerender({
        options: [...LEVELS, { id: "max", label: "Max", description: null }],
      });
      expect(bloom()).toBeNull();
    });

    it("treats a selection that arrives from outside as static", () => {
      mount({ initial: "low" });

      // Hydration, a catalog refresh, another surface writing the store: the
      // value reaches max without anyone moving the slider.
      act(() => liveSeam().setValue("ultra"));

      expect(slider().getAttribute("data-max")).toBe("true");
      expect(bloom()).toBeNull();
    });
  });

  describe("reduced motion", () => {
    it("creates no cue while the preference is on", () => {
      stubReducedMotion(true);
      const { selections } = mount({ initial: "low" });

      select("ultra");

      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");
      expect(thumb().getAttribute("aria-valuetext")).toBe("Ultra");
      expect(selections).toEqual(["ultra"]);
    });

    it("clears an in-flight cue when the preference turns on, and never replays it", () => {
      const media = stubReducedMotion(false);
      mount({ initial: "low" });
      select("ultra");
      expect(bloom()).not.toBeNull();

      // No `animationend` is dispatched: suppressing an animation can swallow
      // it, which is why the state is cleared rather than waited on.
      act(() => {
        media.setMatches(true);
        media.fireChange();
      });
      expect(bloom()).toBeNull();

      act(() => {
        media.setMatches(false);
        media.fireChange();
      });
      expect(bloom()).toBeNull();
      expect(slider().getAttribute("data-max")).toBe("true");
    });
  });

  // The continuous half of the treatment: a band flowing back down the track
  // for as long as max is SELECTED, which is a different question from the
  // one-shot bloom's "max was just arrived at".
  describe("the flowing band", () => {
    function flow(): HTMLElement | null {
      return screen.queryByTestId("model-reasoning-max-flow");
    }

    function liveFlow(): HTMLElement {
      const element = flow();
      if (element === null) throw new Error("Expected a flowing band");
      return element;
    }

    /** The band's travel, read back off the inline style the clock writes. */
    function offsetPercent(element: HTMLElement): number {
      const match = /translateX\((-?[\d.]+)%\)/.exec(element.style.transform);
      if (match?.[1] === undefined) {
        throw new Error(`No translateX in "${element.style.transform}"`);
      }
      return Number(match[1]);
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

    it("runs while max is selected, including a picker opened at max", () => {
      withFakeTimers(() => {
        mount({ initial: "ultra" });

        // No arrival, no bloom - and the flow runs anyway, because it says
        // where the level IS rather than that it just moved.
        expect(bloom()).toBeNull();
        // Subscribed and already written, before the first tick.
        expect(liveFlow().style.transform).toMatch(/^translateX\(-?[\d.]+%\)$/);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
      });
    });

    it("is absent below max, and leaves with the selection", () => {
      withFakeTimers(() => {
        mount({ initial: "low" });
        expect(flow()).toBeNull();
        // Nothing at all runs for a level that is not the top one.
        expect(vi.getTimerCount()).toBe(0);

        select("ultra");
        expect(flow()).not.toBeNull();

        select("high");
        expect(flow()).toBeNull();
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
        const { rerender } = mount({ initial: "ultra" });
        expect(flow(), JSON.stringify(gate)).not.toBeNull();

        rerender(gate);
        expect(flow(), JSON.stringify(gate)).toBeNull();

        // And it comes back when the gate does: the flow is a state, not a
        // one-shot that a closed gate spends.
        rerender({
          open: true,
          paneVisible: true,
          concealed: false,
          disabled: false,
        });
        expect(flow(), JSON.stringify(gate)).not.toBeNull();
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
        mount({ initial: "ultra" });

        expect(flow()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("advances right to left, one wrap per period, and never runs an animation", () => {
      withFakeTimers(() => {
        mount({ initial: "ultra" });
        const band = liveFlow();

        // Written pre-paint at subscribe time, so the first frame is already
        // off the right-hand end rather than parked at the left edge.
        const start = offsetPercent(band);
        expect(start).toBeGreaterThan(100);
        expect(band.style.animation).toBe("");

        let previous = start;
        // 40 ticks of 40ms is exactly the 1600ms period.
        for (let step = 1; step < 40; step += 1) {
          tick(1);
          const next = offsetPercent(band);
          expect(next, `tick ${step}`).toBeLessThan(previous);
          previous = next;
        }
        // Past the left-hand end by the time the pass is over.
        expect(previous).toBeLessThan(0);

        tick(1);
        expect(offsetPercent(band)).toBe(start);
        expect(band.style.animation).toBe("");
      });
    });

    it("leaves no inline style behind when it stops", () => {
      withFakeTimers(() => {
        mount({ initial: "ultra" });
        const band = liveFlow();
        tick(3);
        expect(band.style.transform).not.toBe("");

        select("high");

        expect(flow()).toBeNull();
        expect(band.style.transform).toBe("");
        expect(band.getAttribute("style")).toBe("");
      });
    });

    it("unsubscribes from the shared clock, stopping it when it was the only writer", () => {
      withFakeTimers(() => {
        const { rerender } = mount({ initial: "ultra" });
        tick(2);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        rerender({ open: false });

        // Not merely hidden: the writer is gone, and with no writer left the
        // shared interval stops rather than ticking against a popover nobody
        // can see.
        expect(flow()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("keeps the static halo and tail but does not flow under reduced motion", () => {
      stubReducedMotion(true);
      mount({ initial: "ultra" });

      expect(flow()).toBeNull();
      // The still treatment is exactly what reduced motion keeps.
      expect(slider().getAttribute("data-max")).toBe("true");
      expect(screen.getByTestId("model-reasoning-max-tail")).toBeDefined();
      expect(screen.getByTestId("model-reasoning-thumb-core")).toBeDefined();
    });

    it("stops flowing the moment the preference turns on, and resumes when it turns off", () => {
      const media = stubReducedMotion(false);
      mount({ initial: "ultra" });
      const band = liveFlow();

      act(() => {
        media.setMatches(true);
        media.fireChange();
      });
      expect(flow()).toBeNull();
      expect(band.style.transform).toBe("");

      act(() => {
        media.setMatches(false);
        media.fireChange();
      });
      expect(flow()).not.toBeNull();
    });
  });

  describe("cost and semantics", () => {
    it("keeps the bloom on its own keyframes, off the clock and off rAF", () => {
      // The one-shot half costs nothing continuous: away from max nothing is
      // subscribed, and the bloom itself is CSS that retires on `animationend`.
      // (The flow's subscription while AT max is the section below.)
      const setInterval = vi.spyOn(window, "setInterval");
      const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame");
      try {
        mount({ initial: "low" });
        expect(setInterval).not.toHaveBeenCalled();

        select("ultra");
        expect(bloom()).not.toBeNull();
        endBloom(screen.getByTestId("model-reasoning-max-bloom"));

        expect(requestAnimationFrame).not.toHaveBeenCalled();
        // One interval for the whole app's clock, not one per decoration -
        // and the bloom itself adds none: it is finite CSS from start to end.
        expect(setInterval.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        setInterval.mockRestore();
        requestAnimationFrame.mockRestore();
      }
    });

    it("keeps the thumb far enough from the popover's clipped edge for the ring", () => {
      // The ring reaches ~20px from the thumb's centre (16px thumb, `inset:-4px`
      // scaled to 1.65) and the popover is `overflow-hidden`, so the row has to
      // carry that room: `py-3` here plus the footer's own `py-1.5` is exactly
      // 20px from centre to bottom edge.
      mount({ initial: "ultra", serviceTier: true });

      expect(slider().className).toContain("py-3");
      // Once, not twice: the footer keeps its own padding whether or not the
      // service-tier row shares the row.
      const footer = slider().closest("div.border-t");
      expect(footer?.className).toContain("py-1.5");
      expect(footer?.className).not.toContain("py-3");
    });

    it("leaves the list's own height alone", () => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: "list",
        },
      });
      mount({ initial: "ultra" });

      const footer = screen
        .getByTestId("model-reasoning-scroller")
        .closest("div.border-t");
      expect(footer?.className).toContain("py-1.5");
      expect(footer?.className).not.toContain("py-3");
    });

    it("keeps every decoration out of the accessibility tree and the tab order", () => {
      mount({ initial: "low" });
      fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));

      for (const testId of [
        "model-reasoning-thumb-core",
        "model-reasoning-max-tail",
        "model-reasoning-max-bloom",
        "model-reasoning-max-flow",
      ]) {
        const decoration = screen.getByTestId(testId);
        expect(decoration.getAttribute("aria-hidden"), testId).toBe("true");
        expect(decoration.getAttribute("tabindex"), testId).toBeNull();
        expect(decoration.getAttribute("role"), testId).toBeNull();
      }
      // The bloom decorates the thumb; it must never become the thumb.
      expect(screen.getAllByRole("slider")).toHaveLength(1);
      expect(thumb().className).toContain("focus-visible:ring-2");
    });
  });
});
