import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type { ReasoningLevelOption } from "@/components/home/data/landing-options";
import { stubSliderGeometry } from "@/components/home/pickers/__tests__/slider-pointer-geometry";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import {
  LeaderHeldContext,
  type LeaderState,
} from "@/providers/keybinding-context";
import { LEADER_SCOPE_MODEL_PICKER } from "@/lib/keybindings/leader-scope";
import { reasoningDragPosition } from "@/components/home/pickers/use-reasoning-slider-gesture";

const ALT_NOT_HELD: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

const ALT_HELD_BY_PICKER: LeaderState = {
  modHeld: false,
  altHeld: true,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: LEADER_SCOPE_MODEL_PICKER,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

// Catalog order, NOT alphabetical and NOT sorted by effort: the host reports
// the ladder and the footer draws it in the order it arrived.
const FOUR_OPTIONS: ReadonlyArray<ReasoningLevelOption> = [
  { id: "low", label: "Low", description: null },
  { id: "medium", label: "Medium", description: null },
  { id: "high", label: "High", description: null },
  { id: "max", label: "Max", description: null },
];

// pi's shape: a no-thinking level advertised alongside graded ones.
const ZERO_EFFORT_OPTIONS: ReadonlyArray<ReasoningLevelOption> = [
  { id: "off", label: "Off", description: null },
  { id: "low", label: "Low", description: null },
  { id: "high", label: "High", description: null },
];

function reasoningConfig(
  value: string,
  options: ReadonlyArray<ReasoningLevelOption>,
  onChange: (next: string) => void,
): ReasoningFooterConfig {
  return { value, options, disabled: false, onChange };
}

// Base's edge-aligned Slider Thumb measures its own position in a layout
// effect that only resolves after a real microtask tick (`queueMicrotask` /
// a passive-effect fallback), so `render()` alone leaves the thumb
// `visibility: hidden` - out of the accessibility tree - in jsdom. Every
// caller awaits this rather than each test working out its own flush.
async function renderFooter(config: ReasoningFooterConfig): Promise<void> {
  render(
    <HarnessModelPickerModelSettingsFooter
      pickerOpen
      reasoning={config}
      serviceTier={null}
    />,
  );
  await act(() => Promise.resolve());
}

/**
 * The footer with the level held in state, the way the composer store holds it.
 * Returns the running list of selections. Needed wherever a gesture's SECOND
 * event has to see what its first one did.
 */
async function renderStatefulFooter(
  initial: string,
): Promise<ReadonlyArray<string>> {
  const selections: Array<string> = [];
  function StatefulFooter() {
    const [value, setValue] = useState(initial);
    return (
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={{
          value,
          options: FOUR_OPTIONS,
          disabled: false,
          onChange: (next) => {
            selections.push(next);
            setValue(next);
          },
        }}
        serviceTier={null}
      />
    );
  }
  render(<StatefulFooter />);
  await act(() => Promise.resolve());
  return selections;
}

// The native `input[type=range]` (role, aria, keyboard, focus) - separate
// from `thumbVisual()` below because the two are different DOM nodes now.
function thumb(): HTMLElement {
  return screen.getByRole("slider", { name: "Thinking effort" });
}

/** The styled `span` a thumb visual/size assertion means - not the input. */
function thumbVisual(): HTMLElement {
  const element = screen
    .getByTestId("model-reasoning-slider")
    .querySelector('[data-slot="slider-thumb"]');
  if (!(element instanceof HTMLElement)) {
    throw new Error("No thumb visual");
  }
  return element;
}

function stops(): ReadonlyArray<HTMLElement> {
  return screen.getAllByTestId(/^model-reasoning-stop-/);
}

/**
 * The thumb-centre rem offset baked into the range's `width: calc(...)`.
 * The browser's CSSOM re-serializes `calc(x% + -yrem)` as `calc(x% - yrem)`
 * on readback, so the sign is its own capture group.
 */
function rangeInsetRem(): number {
  const width = screen.getByTestId("model-reasoning-range").style.width;
  const match = /([+-])\s*([\d.]+)rem\)$/.exec(width);
  if (match === null) {
    throw new Error(`No rem offset in width: ${width}`);
  }
  return parseFloat(match[2]) * (match[1] === "-" ? -1 : 1);
}

describe("<HarnessModelPickerModelSettingsFooter /> reasoning slider", () => {
  // Base's Slider Thumb positions itself from a real measurement and stays
  // `visibility: hidden` (so out of the accessibility tree) until it has one;
  // jsdom reports every rect as zero-sized, so every test - not just the drag
  // ones - needs the stub, or `thumb()` itself cannot find the control.
  let restoreSliderGeometry: () => void;

  beforeEach(() => {
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    restoreSliderGeometry = stubSliderGeometry();
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    restoreSliderGeometry();
  });

  it("is what the footer draws with no setting touched", async () => {
    expect(PRESET_VALUES.default.model.reasoningControl).toBe("slider");

    await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(screen.getByTestId("model-reasoning-slider")).toBeDefined();
    expect(screen.queryByTestId("model-reasoning-scroller")).toBeNull();
  });

  it("draws one stop per catalog level, in catalog order", async () => {
    await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));

    expect(stops().map((stop) => stop.getAttribute("aria-label"))).toEqual([
      "Low",
      "Medium",
      "High",
      "Max",
    ]);
  });

  it("parks the thumb on the selected level and names it, not its index", async () => {
    await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(thumb().getAttribute("aria-valuenow")).toBe("2");
    // The native input carries `min`/`max`, not explicit `aria-valuemin`/
    // `aria-valuemax` - the browser computes those from the native pair.
    expect(thumb().getAttribute("min")).toBe("0");
    expect(thumb().getAttribute("max")).toBe("3");
    expect(thumb().getAttribute("aria-valuetext")).toBe("High");
    // The name sits beside the track too, so the dots never stand alone.
    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "High",
    );
  });

  it("selects the level under a stop that is clicked", async () => {
    const onChange = vi.fn<(next: string) => void>();
    await renderFooter(reasoningConfig("low", FOUR_OPTIONS, onChange));

    fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));

    expect(onChange).toHaveBeenCalledWith("max");
  });

  it("keeps the level a drag landed on, even though the click lands back on the stop it started from", async () => {
    // The browser dispatches the trailing click to the element the pointer went
    // DOWN on, whatever it was released over - so a drag that starts on a dot
    // ends with a click on that dot, and an unconditional handler there would
    // undo the drag it just finished. Stateful, because the bug only shows once
    // the level has actually moved away from the stop the click lands on.
    const selections = await renderStatefulFooter("low");
    const start = screen.getByTestId("model-reasoning-stop-0");

    fireEvent.pointerDown(start, { pointerId: 1, clientX: 0, button: 0 });
    // `buttons: 1` - the primary button still held through the move, or the
    // gesture's own `event.buttons === 0` guard now (correctly) treats this
    // as a release and clears the "moved" flag before the click below.
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 400, buttons: 1 });
    fireEvent.pointerUp(start, { pointerId: 1, clientX: 400 });
    fireEvent.click(start);

    // The drag already moved it along the track; the click must not drag it home.
    expect(selections.at(-1)).toBe("max");
    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "Max",
    );
  });

  it("still selects on a click that no gesture moved", async () => {
    // The other half of the same rule: a tap that never travelled, and an
    // assistive technology activating the button, produce a click with nothing
    // behind it and must still pick the level.
    const selections = await renderStatefulFooter("low");
    const stop = screen.getByTestId("model-reasoning-stop-2");

    fireEvent.pointerDown(stop, { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerUp(stop, { pointerId: 1, clientX: 0 });
    fireEvent.click(stop);

    expect(selections.at(-1)).toBe("high");
  });

  it("writes nothing when the stop already selected is clicked", async () => {
    const onChange = vi.fn<(next: string) => void>();
    await renderFooter(reasoningConfig("low", FOUR_OPTIONS, onChange));

    fireEvent.click(screen.getByTestId("model-reasoning-stop-0"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps one level per arrow key and jumps to the ends on Home/End", async () => {
    const onChange = vi.fn<(next: string) => void>();
    await renderFooter(reasoningConfig("medium", FOUR_OPTIONS, onChange));

    fireEvent.keyDown(thumb(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("high");

    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("low");

    fireEvent.keyDown(thumb(), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("max");

    fireEvent.keyDown(thumb(), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("low");
  });

  it("jumps toward an end on PageUp/PageDown, clamped to the real range", async () => {
    // Base's own `largeStep` defaults to 10 (`SliderRoot.js`) and the
    // production Slider never overrides it, so on a 4-level (0-3) range
    // PageUp/PageDown always overshoot and clamp - a distinct branch from
    // Home/End (`SliderThumb.js`'s `onKeyDown` sets `newValue` directly for
    // Home/End, but routes Page keys through the same `getNewValue` clamp
    // arrow keys use, just with `increment = largeStep`).
    const onChange = vi.fn<(next: string) => void>();
    await renderFooter(reasoningConfig("medium", FOUR_OPTIONS, onChange));

    fireEvent.keyDown(thumb(), { key: "PageUp" });
    expect(onChange).toHaveBeenLastCalledWith("max");

    fireEvent.keyDown(thumb(), { key: "PageDown" });
    expect(onChange).toHaveBeenLastCalledWith("low");
  });

  it("keeps a zero-effort level as the leftmost stop", async () => {
    const onChange = vi.fn<(next: string) => void>();
    await renderFooter(reasoningConfig("low", ZERO_EFFORT_OPTIONS, onChange));

    expect(stops().at(0)?.getAttribute("aria-label")).toBe("Off");

    fireEvent.keyDown(thumb(), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("off");
  });

  it("updates the name beside the track when the level changes", () => {
    const { rerender } = render(
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={reasoningConfig("low", FOUR_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );
    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "Low",
    );

    rerender(
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={reasoningConfig("max", FOUR_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );

    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "Max",
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("3");
  });

  // Reserve the label width so changing names cannot shift the track.
  describe("level label", () => {
    function label(): HTMLElement {
      return screen.getByTestId("model-reasoning-level-name");
    }

    it("sits after the track in a fixed-width, right-aligned slot", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const name = label();
      expect(name.textContent).toBe("High");
      expect(name.getAttribute("aria-hidden")).toBeNull();
      const row = name.parentElement;
      expect(row?.className).not.toContain("flex-col");
      expect(name.previousElementSibling).toBe(
        screen.getByTestId("model-reasoning-slider"),
      );
      expect(row?.lastElementChild).toBe(name);
      expect(name.className).toContain("w-[9ch]");
      expect(name.className).toContain("shrink-0");
      expect(name.className).toContain("text-end");
      expect(screen.queryAllByTestId("model-reasoning-level-sizer")).toEqual(
        [],
      );
    });

    // The class set is what a jsdom test can read of the geometry: if the
    // selected level could change it, it could change the layout.
    it("draws the same label cell at the first level as at the last", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const atFirst = label().className;
      cleanup();

      await renderFooter(reasoningConfig("max", FOUR_OPTIONS, vi.fn()));

      expect(label().className).toBe(atFirst);
    });

    it("names a level the catalog does not list, and truncates a long one", async () => {
      const remembered = "a-remembered-level-nobody-advertises-any-more";
      await renderFooter(reasoningConfig(remembered, FOUR_OPTIONS, vi.fn()));

      expect(label().textContent).toBe(remembered);
      expect(label().className).toContain("truncate");
      expect(label().className).toContain("max-w-[40%]");
      expect(thumb().getAttribute("aria-valuenow")).toBe("0");
      expect(thumb().getAttribute("aria-valuetext")).toBe(remembered);
    });

    it("leaves the list control without a label at all", async () => {
      useLayoutStore
        .getState()
        .setRegionValues("model", { reasoningControl: "list" });

      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(screen.queryByTestId("model-reasoning-level-name")).toBeNull();
    });
  });

  // The compact pill, and the geometry that has to move with it.
  describe("pill geometry", () => {
    function track(): HTMLElement {
      const element = screen
        .getByTestId("model-reasoning-slider")
        .querySelector('[data-slot="slider-track"]');
      if (!(element instanceof HTMLElement)) {
        throw new Error("No track");
      }
      return element;
    }

    it("asks the primitive for the pill size on the track and the thumb alike", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(track().getAttribute("data-size")).toBe("pill");
      expect(thumbVisual().getAttribute("data-size")).toBe("pill");
      // The pill's own height is a LOCAL override (h-4, slimmer than the
      // primitive's own h-9 pill default), merged on top via `cn()` -
      // `cn` strips the primitive's conflicting class.
      expect(track().className).toContain("data-[size=pill]:h-4");
      expect(track().className).not.toContain("data-[size=pill]:h-9");
      expect(track().className).toContain("h-1");
      expect(thumbVisual().className).toContain("data-[size=pill]:size-6");
      expect(thumbVisual().className).toContain("size-4");
    });

    // A 1px border, not the primitive's own pill default (`border-2`) and not
    // borderless: zero border made the thumb read as one surface with the
    // track under a neutral/monochrome theme, so the local override restores
    // separation without the primitive's thicker ring. Token-exact match
    // (not `.toContain`) because "border" is also a literal substring of
    // "border-2" and "border-popover".
    it("restores a 1px thumb border over the primitive's own pill default", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const classes = thumbVisual().className.split(/\s+/);
      expect(classes).toContain("data-[size=pill]:border");
      expect(classes).not.toContain("data-[size=pill]:border-2");
      expect(classes).not.toContain("data-[size=pill]:border-0");
      // The primitive's pill border COLOUR is untouched - only width conflicts.
      expect(classes).toContain("data-[size=pill]:border-popover");
    });

    // `thumbAlignment="edge"` parks the thumb's CENTRE half a thumb inside
    // each end, so the overlay the stops are laid out in has to be inset by
    // exactly that - 0.75rem for the 1.5rem pill thumb.
    it("insets the stop overlay by half the pill thumb", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const overlay = stops().at(0)?.parentElement?.parentElement;
      expect(overlay?.className).toContain("px-3");
      // And matches the slider's own padding vertically, so the overlay is the
      // track's box rather than the padded row's.
      expect(overlay?.className).toContain("py-1");
      // Neighboring stop targets must not cover the thumb in a narrow picker.
      expect(overlay?.className).not.toContain("z-10");
      expect(stops().at(0)?.className).not.toContain("z-10");
      // Only the inert selected stop rises above it to keep its hint visible.
      expect(stops().at(2)?.className).toContain("z-10");
      expect(stops().at(2)?.className).toContain("pointer-events-none");
      expect(screen.getByTestId("model-reasoning-slider").className).toContain(
        "py-1",
      );
    });

    it("keeps each stop taller than the slim track with a coarse-pointer width", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      for (const stop of stops()) {
        expect(stop.className).toContain("h-6");
        expect(stop.className).toContain("w-5");
        expect(stop.className).toContain("pointer-coarse:w-6");
      }
    });

    it("colours a dot for the surface under it: fill to the left, base to the right", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const dots = FOUR_OPTIONS.map((_, index) =>
        screen.getByTestId(`model-reasoning-dot-${index}`),
      );
      // `high` is index 2, so 0 and 1 are under the fill and 3 is not.
      expect(dots[0]?.className).toContain("bg-primary-foreground/35");
      expect(dots[1]?.className).toContain("bg-primary-foreground/35");
      expect(dots[3]?.className).toContain("bg-foreground/25");
      // Only the DOT goes transparent under the thumb - the stop button
      // itself stays visible (so its leader badge can too) and is instead
      // made inert with `pointer-events-none`, not hidden.
      expect(dots[2]?.className).toContain("opacity-0");
      expect(stops().at(2)?.className).not.toContain("opacity-0");
      expect(stops().at(2)?.className).toContain("pointer-events-none");
    });

    it("fills solid up to the thumb", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const range = screen.getByTestId("model-reasoning-range");
      expect(range.className).toContain("bg-primary");
      expect(range.className).not.toContain("bg-primary/70");
    });

    it("draws a square covered edge - no rounded-full crescent between the range and the track", async () => {
      await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(
        screen.getByTestId("model-reasoning-range").className,
      ).not.toContain("rounded-full");
    });

    it("insets the range's covered edge by the thumb-centre offset, scaled by position", async () => {
      // FOUR_OPTIONS has lastIndex 3. Base's Range fills a raw percentage
      // with no inset of its own, so the call site adds the thumb-centre
      // offset directly into its `width` (not a `marginInlineEnd`, which is
      // how a prior Radix-based version read this): +0.75rem of extra width
      // at the lowest stop, shrinking to -0.75rem at the highest, matching
      // the thumb-centre inset `thumbAlignment="edge"` gives each end
      // instead of leaving the range on raw, uninset percentages.
      const cases: ReadonlyArray<readonly [string, number]> = [
        ["low", 0.75],
        ["medium", 0.25], // (1 - 2 * (1 / 3)) * 0.75
        ["high", -0.25], // (1 - 2 * (2 / 3)) * 0.75
        ["max", -0.75],
      ];
      for (const [value, expectedRem] of cases) {
        cleanup();
        await renderFooter(reasoningConfig(value, FOUR_OPTIONS, vi.fn()));
        expect(rangeInsetRem(), value).toBeCloseTo(expectedRem, 6);
      }
    });

    it("insets by the magnetically-pulled preview position during a drag, not the raw pointer position", async () => {
      await renderStatefulFooter("low");
      const stop = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(stop, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      // 153 lands the finger exactly on 1.125 once the 12px thumb-centre
      // inset on each edge is subtracted (376px usable span): (153-12)/376*3.
      fireEvent.pointerMove(stop, {
        pointerId: 1,
        clientX: 153,
        clientY: 0,
        buttons: 1,
      });

      const pulledPosition = reasoningDragPosition(1.125, 3);
      const expectedRemOffset = (1 - (2 * pulledPosition) / 3) * 0.75;
      const rawRemOffset = (1 - (2 * 1.125) / 3) * 0.75;
      const rem = rangeInsetRem();

      expect(rem).toBeCloseTo(expectedRemOffset, 6);
      expect(rem).not.toBeCloseTo(rawRemOffset, 4);
    });
  });

  it("falls back to the list for a model that advertises a single level", async () => {
    await renderFooter(
      reasoningConfig(
        "only",
        [{ id: "only", label: "Only", description: null }],
        vi.fn(),
      ),
    );

    expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
    expect(screen.getByTestId("model-reasoning-scroller")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Only" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("renders the list, and no slider, under the `list` setting", async () => {
    useLayoutStore
      .getState()
      .setRegionValues("model", { reasoningControl: "list" });

    await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
    expect(screen.getByTestId("model-reasoning-scroller")).toBeDefined();
    for (const option of FOUR_OPTIONS) {
      expect(screen.getByRole("button", { name: option.label })).toBeDefined();
    }
  });

  it("keeps the thinking-effort group's name in either control", async () => {
    await renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(
      screen.getByRole("group", { name: "Thinking effort" }),
    ).not.toBeNull();
  });

  it("refuses every route while the model's levels are disabled", async () => {
    const onChange = vi.fn<(next: string) => void>();
    render(
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={{
          value: "low",
          options: FOUR_OPTIONS,
          disabled: true,
          onChange,
        }}
        serviceTier={null}
      />,
    );
    await act(() => Promise.resolve());

    // The native `<input type=range disabled>` (Base wires `disabled`
    // straight onto it - `SliderThumb.js`) is what a real browser refuses to
    // focus or deliver a keydown to; firing `keyDown` directly on it would
    // pass even if the contract broke, since jsdom does not gate a
    // programmatic dispatch on `disabled` the way it gates a real click.
    // Prove the disabled attribute and the resulting unfocusability instead
    // of simulating an interaction no real user could produce.
    expect(thumb()).toHaveProperty("disabled", true);
    thumb().focus();
    expect(document.activeElement).not.toBe(thumb());

    fireEvent.click(screen.getByTestId("model-reasoning-stop-2"));

    expect(onChange).not.toHaveBeenCalled();
  });

  // `data-dragging` is a LOCAL gesture read (raw pointer distance from
  // pointerdown, gated on a button actually being held) - separate from
  // Base's own value-changing pointer math, which the drag tests above
  // already cover. It only flips `.reasoning-effort-slider[data-dragging]`'s
  // CSS (disables the travel transition mid-drag), so it is asserted here as
  // the `data-dragging` attribute rather than through a selection.
  describe("drag arming", () => {
    it("does not arm on jitter of 3px or less from pointerdown", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const slider = screen.getByTestId("model-reasoning-slider");

      fireEvent.pointerDown(slider, {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        button: 0,
      });
      fireEvent.pointerMove(slider, {
        pointerId: 1,
        clientX: 102,
        clientY: 100,
        buttons: 1,
      });
      expect(slider.getAttribute("data-dragging")).toBeNull();

      // Past the threshold, the same gesture DOES arm - proves the assertion
      // above is a real threshold, not a handler that never fires.
      fireEvent.pointerMove(slider, {
        pointerId: 1,
        clientX: 105,
        clientY: 100,
        buttons: 1,
      });
      expect(slider.getAttribute("data-dragging")).toBe("true");
    });

    it("does not arm on a move reporting no button held", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const slider = screen.getByTestId("model-reasoning-slider");

      fireEvent.pointerDown(slider, {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        button: 0,
      });
      // Large distance, but `buttons: 0` - a move with nothing pressed must
      // not arm the drag whatever it travelled.
      fireEvent.pointerMove(slider, {
        pointerId: 1,
        clientX: 300,
        clientY: 100,
        buttons: 0,
      });
      expect(slider.getAttribute("data-dragging")).toBeNull();
    });
  });

  // `useReasoningSliderGesture` previews the drag continuously (`step: 0.001`,
  // `position: pointerValue ?? thumbIndex`, a scalar - Base's single-thumb
  // Slider takes a bare number, not a one-element array) so the thumb glides
  // instead of hopping between stops, but the ONLY thing ever handed to
  // `onChange` is `Math.round(position)` - a real catalog index.
  describe("continuous drag preview", () => {
    it("rounds every fractional pointer position to a real catalog level, never an invalid one", async () => {
      // Stateful: `selectLevel` commits on every rounding-boundary crossing,
      // not just on release, so a stateless footer would never re-render with
      // the rounded selection and this assertion would still see the
      // pre-drag level.
      const selections = await renderStatefulFooter("low");
      const stop = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(stop, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      // 153 -> raw position 1.125 - a position with no catalog entry at all -
      // rounds to index 1 ("medium").
      fireEvent.pointerMove(stop, {
        pointerId: 1,
        clientX: 153,
        clientY: 0,
        buttons: 1,
      });

      expect(selections.length).toBeGreaterThan(0);
      const validIds = new Set(FOUR_OPTIONS.map((option) => option.id));
      for (const selection of selections) {
        expect(validIds.has(selection)).toBe(true);
      }
      expect(selections.at(-1)).toBe("medium");
      // The thumb's spoken name is the rounded catalog level even mid-drag
      // (`aria-valuetext` tracks the committed `value` prop). Its numeric
      // `aria-valuenow` is Base's own, and stays the raw continuous preview
      // until release - that fractional reading is not a promise this
      // control makes to assistive tech, only the settled value is (covered
      // below, on release).
      expect(thumb().getAttribute("aria-valuetext")).toBe("Medium");
    });

    it("settles to the whole level on release, and a subsequent arrow key still steps by exactly one level", async () => {
      const selections = await renderStatefulFooter("low");
      const stop = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(stop, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      fireEvent.pointerMove(stop, {
        pointerId: 1,
        clientX: 153,
        clientY: 0,
        buttons: 1,
      });
      fireEvent.pointerUp(stop, { pointerId: 1, clientX: 153, clientY: 0 });

      expect(selections.at(-1)).toBe("medium");
      expect(
        screen
          .getByTestId("model-reasoning-slider")
          .getAttribute("data-dragging"),
      ).toBeNull();
      // Released: Base's own thumb value is no longer the continuous preview,
      // so its numeric `aria-valuenow` settles on the rounded catalog index,
      // and the spoken name agrees with it.
      expect(thumb().getAttribute("aria-valuenow")).toBe("1");
      expect(thumb().getAttribute("aria-valuetext")).toBe("Medium");

      fireEvent.keyDown(thumb(), { key: "ArrowRight" });

      // One whole level up from "medium" ("high") - not a fractional step,
      // and not the pre-drag "low" either. A keyboard step is never
      // fractional, so both the number and the name land on it together.
      expect(selections.at(-1)).toBe("high");
      expect(thumb().getAttribute("aria-valuenow")).toBe("2");
      expect(thumb().getAttribute("aria-valuetext")).toBe("High");
    });

    it("keeps every dot visible mid-drag, hiding only the settled selection once released", async () => {
      // `selected`/`overFill` compare against the CONTINUOUS `gesture.position`,
      // not the rounded committed index - so a dot the thumb has not visually
      // reached yet cannot be marked "selected" (and hidden) ahead of it.
      await renderStatefulFooter("low");
      const stop = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(stop, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      // 153 -> raw position 1.125 - between stops 1 and 2, exactly equal to
      // neither.
      fireEvent.pointerMove(stop, {
        pointerId: 1,
        clientX: 153,
        clientY: 0,
        buttons: 1,
      });

      for (let index = 0; index < FOUR_OPTIONS.length; index += 1) {
        expect(
          screen.getByTestId(`model-reasoning-dot-${index}`).className,
          `dot ${index} mid-drag`,
        ).not.toContain("opacity-0");
      }

      fireEvent.pointerUp(stop, { pointerId: 1, clientX: 153, clientY: 0 });

      // Settled on "medium" (index 1) - now exactly that dot hides.
      expect(screen.getByTestId("model-reasoning-dot-1").className).toContain(
        "opacity-0",
      );
      expect(
        screen.getByTestId("model-reasoning-dot-0").className,
      ).not.toContain("opacity-0");
    });

    it("resets the stale moved/active flags on a buttons-0 pointermove, so a later assistive click still selects", async () => {
      // Without this reset, `movedByGesture()` (active && moved) would still
      // read true from the earlier drag and swallow the next click outright -
      // e.g. an assistive-technology activation that never goes through
      // pointerdown/pointerup at all.
      const onChange = vi.fn<(next: string) => void>();
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, onChange));
      const stop0 = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(stop0, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      // A real drag, so Base's `onValueChange` marks the gesture "moved".
      fireEvent.pointerMove(stop0, {
        pointerId: 1,
        clientX: 150,
        clientY: 0,
        buttons: 1,
      });
      // The pointer let go without a `pointerup` ever reaching this
      // element - only a move reporting no button held, the exact edge
      // case the reset targets.
      fireEvent.pointerMove(stop0, {
        pointerId: 1,
        clientX: 150,
        clientY: 0,
        buttons: 0,
      });

      onChange.mockClear();
      fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));

      expect(onChange).toHaveBeenLastCalledWith("max");
    });

    it("previews a position pulled toward the nearest stop while still committing the raw rounded level", async () => {
      // Ties the pure `reasoningDragPosition` math (unit-tested on its own in
      // use-reasoning-slider-gesture.test.ts) to this exact drag scenario:
      // the same 1.125 raw position the "rounds every fractional..." test
      // above commits as "medium".
      const selections = await renderStatefulFooter("low");
      const stop = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(stop, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      // 153 -> raw position 1.125.
      fireEvent.pointerMove(stop, {
        pointerId: 1,
        clientX: 153,
        clientY: 0,
        buttons: 1,
      });

      // FOUR_OPTIONS has lastIndex 3, so the small-ladder cap scales the
      // pull to 0.07 * (3/5) = 0.042 here, not the uncapped 0.07.
      const rawPosition = 1.125;
      const pulledPreview = reasoningDragPosition(rawPosition, 3);
      expect(pulledPreview).not.toBe(rawPosition);
      expect(pulledPreview).toBeCloseTo(1.095301515, 6);
      expect(selections.at(-1)).toBe("medium");
    });
  });

  describe("pressed state", () => {
    it("is set for the whole physical gesture and clears on release", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const slider = screen.getByTestId("model-reasoning-slider");

      fireEvent.pointerDown(slider, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      expect(slider.getAttribute("data-pressed")).toBe("true");

      fireEvent.pointerUp(slider, { pointerId: 1, clientX: 0, clientY: 0 });
      expect(slider.getAttribute("data-pressed")).toBeNull();
    });

    it("clears on pointercancel", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const slider = screen.getByTestId("model-reasoning-slider");

      fireEvent.pointerDown(slider, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      fireEvent.pointerCancel(slider, { pointerId: 1 });

      expect(slider.getAttribute("data-pressed")).toBeNull();
    });

    it("clears on losing pointer capture", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const slider = screen.getByTestId("model-reasoning-slider");

      fireEvent.pointerDown(slider, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      fireEvent.lostPointerCapture(slider, { pointerId: 1 });

      expect(slider.getAttribute("data-pressed")).toBeNull();
    });

    it("clears on a move reporting no button held", async () => {
      await renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const slider = screen.getByTestId("model-reasoning-slider");

      fireEvent.pointerDown(slider, {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
      });
      fireEvent.pointerMove(slider, {
        pointerId: 1,
        clientX: 50,
        clientY: 0,
        buttons: 0,
      });

      expect(slider.getAttribute("data-pressed")).toBeNull();
    });
  });

  describe("leader-hold tooltip interaction", () => {
    function statelessConfig(): ReasoningFooterConfig {
      return reasoningConfig("low", FOUR_OPTIONS, vi.fn());
    }

    it("clears a held-open tooltip on a real pointerleave while the modifier is still held, and does not reopen on release", () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const view = render(
        <LeaderHeldContext.Provider value={ALT_NOT_HELD}>
          <HarnessModelPickerModelSettingsFooter
            pickerOpen
            reasoning={statelessConfig()}
            serviceTier={null}
          />
        </LeaderHeldContext.Provider>,
      );
      const stop = screen.getByTestId("model-reasoning-stop-0");

      // Focus opens the tooltip the cheap way (same mechanism
      // `tooltipTextFor` relies on) - avoids the real hover's open delay and
      // fake timers.
      fireEvent.focus(stop);
      expect(screen.queryByRole("tooltip")).not.toBeNull();

      // Hold ⌥: the leader scope now owns this stop's digit hint, forcing the
      // tooltip closed via the controlled `open={false}`.
      view.rerender(
        <LeaderHeldContext.Provider value={ALT_HELD_BY_PICKER}>
          <HarnessModelPickerModelSettingsFooter
            pickerOpen
            reasoning={statelessConfig()}
            serviceTier={null}
          />
        </LeaderHeldContext.Provider>,
      );
      expect(screen.queryByRole("tooltip")).toBeNull();

      // A real pointerleave while still held: Radix's own `onOpenChange` is
      // suppressed here (the controlled prop already reads `false`), so this
      // exercises the explicit `onPointerLeave` handler that clears the
      // remembered hover directly.
      fireEvent.pointerLeave(stop);

      // Release ⌥.
      view.rerender(
        <LeaderHeldContext.Provider value={ALT_NOT_HELD}>
          <HarnessModelPickerModelSettingsFooter
            pickerOpen
            reasoning={statelessConfig()}
            serviceTier={null}
          />
        </LeaderHeldContext.Provider>,
      );

      // Must not reopen - the pointer already left while it was forced shut.
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
