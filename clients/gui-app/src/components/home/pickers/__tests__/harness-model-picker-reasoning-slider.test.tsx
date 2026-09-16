import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type { ReasoningLevelOption } from "@/components/home/data/landing-options";
import { stubSliderGeometry } from "@/components/home/pickers/__tests__/slider-pointer-geometry";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
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

function renderFooter(config: ReasoningFooterConfig): void {
  render(
    <HarnessModelPickerModelSettingsFooter
      pickerOpen
      reasoning={config}
      serviceTier={null}
    />,
  );
}

/**
 * The footer with the level held in state, the way the composer store holds it.
 * Returns the running list of selections. Needed wherever a gesture's SECOND
 * event has to see what its first one did.
 */
function renderStatefulFooter(initial: string): ReadonlyArray<string> {
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
  return selections;
}

function thumb(): HTMLElement {
  return screen.getByRole("slider", { name: "Thinking effort" });
}

function stops(): ReadonlyArray<HTMLElement> {
  return screen.getAllByTestId(/^model-reasoning-stop-/);
}

describe("<HarnessModelPickerModelSettingsFooter /> reasoning slider", () => {
  beforeEach(() => {
    useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  });

  it("is what the footer draws with no setting touched", () => {
    expect(DEFAULT_COMPOSER_LAYOUT.reasoningFooterControl).toBe("slider");

    renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(screen.getByTestId("model-reasoning-slider")).toBeDefined();
    expect(screen.queryByTestId("model-reasoning-scroller")).toBeNull();
  });

  it("draws one stop per catalog level, in catalog order", () => {
    renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));

    expect(stops().map((stop) => stop.getAttribute("aria-label"))).toEqual([
      "Low",
      "Medium",
      "High",
      "Max",
    ]);
  });

  it("parks the thumb on the selected level and names it, not its index", () => {
    renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(thumb().getAttribute("aria-valuenow")).toBe("2");
    expect(thumb().getAttribute("aria-valuemin")).toBe("0");
    expect(thumb().getAttribute("aria-valuemax")).toBe("3");
    expect(thumb().getAttribute("aria-valuetext")).toBe("High");
    // The name is above the track too, so the dots never stand alone.
    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "High",
    );
  });

  it("selects the level under a stop that is clicked", () => {
    const onChange = vi.fn<(next: string) => void>();
    renderFooter(reasoningConfig("low", FOUR_OPTIONS, onChange));

    fireEvent.click(screen.getByTestId("model-reasoning-stop-3"));

    expect(onChange).toHaveBeenCalledWith("max");
  });

  it("keeps the level a drag landed on, even though the click lands back on the stop it started from", () => {
    // The browser dispatches the trailing click to the element the pointer went
    // DOWN on, whatever it was released over - so a drag that starts on a dot
    // ends with a click on that dot, and an unconditional handler there would
    // undo the drag it just finished. Stateful, because the bug only shows once
    // the level has actually moved away from the stop the click lands on.
    const restore = stubSliderGeometry();
    try {
      const selections = renderStatefulFooter("low");
      const start = screen.getByTestId("model-reasoning-stop-0");

      fireEvent.pointerDown(start, { pointerId: 1, clientX: 0, button: 0 });
      // `buttons: 1` - the primary button still held through the move, or the
      // gesture's own `event.buttons === 0` guard now (correctly) treats this
      // as a release and clears the "moved" flag before the click below.
      fireEvent.pointerMove(start, { pointerId: 1, clientX: 400, buttons: 1 });
      fireEvent.pointerUp(start, { pointerId: 1, clientX: 400 });
      fireEvent.click(start);

      // Radix moved it along the track; the click must not drag it home.
      expect(selections.at(-1)).toBe("max");
      expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
        "Max",
      );
    } finally {
      restore();
    }
  });

  it("still selects on a click that no gesture moved", () => {
    // The other half of the same rule: a tap that never travelled, and an
    // assistive technology activating the button, produce a click with nothing
    // behind it and must still pick the level.
    const restore = stubSliderGeometry();
    try {
      const selections = renderStatefulFooter("low");
      const stop = screen.getByTestId("model-reasoning-stop-2");

      fireEvent.pointerDown(stop, { pointerId: 1, clientX: 0, button: 0 });
      fireEvent.pointerUp(stop, { pointerId: 1, clientX: 0 });
      fireEvent.click(stop);

      expect(selections.at(-1)).toBe("high");
    } finally {
      restore();
    }
  });

  it("writes nothing when the stop already selected is clicked", () => {
    const onChange = vi.fn<(next: string) => void>();
    renderFooter(reasoningConfig("low", FOUR_OPTIONS, onChange));

    fireEvent.click(screen.getByTestId("model-reasoning-stop-0"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps one level per arrow key and jumps to the ends on Home/End", () => {
    const onChange = vi.fn<(next: string) => void>();
    renderFooter(reasoningConfig("medium", FOUR_OPTIONS, onChange));

    fireEvent.keyDown(thumb(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("high");

    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("low");

    fireEvent.keyDown(thumb(), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("max");

    fireEvent.keyDown(thumb(), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("low");
  });

  it("keeps a zero-effort level as the leftmost stop", () => {
    const onChange = vi.fn<(next: string) => void>();
    renderFooter(reasoningConfig("low", ZERO_EFFORT_OPTIONS, onChange));

    expect(stops().at(0)?.getAttribute("aria-label")).toBe("Off");

    fireEvent.keyDown(thumb(), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("off");
  });

  it("moves the name above the track when the level changes", () => {
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

  // The track may not move when the name changes. It cannot any more: the name
  // is on its own line ABOVE the track, so its width is not the track's
  // business at all and the reserved-width sizer stack that used to hold the
  // line steady is gone with it.
  describe("level label", () => {
    function label(): HTMLElement {
      return screen.getByTestId("model-reasoning-level-name");
    }

    it("sits above the track, not beside it, with nothing reserving width", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const name = label();
      expect(name.textContent).toBe("High");
      expect(name.getAttribute("aria-hidden")).toBeNull();
      // The row the slider lives in stacks; the name is the slider's previous
      // sibling rather than a cell in the same line.
      const row = name.parentElement;
      expect(row?.className).toContain("flex-col");
      expect(row?.lastElementChild).toBe(
        screen.getByTestId("model-reasoning-slider"),
      );
      expect(screen.queryAllByTestId("model-reasoning-level-sizer")).toEqual(
        [],
      );
    });

    // The class set is what a jsdom test can read of the geometry: if the
    // selected level could change it, it could change the layout.
    it("draws the same label cell at the first level as at the last", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const atFirst = label().className;
      cleanup();

      renderFooter(reasoningConfig("max", FOUR_OPTIONS, vi.fn()));

      expect(label().className).toBe(atFirst);
    });

    it("names a level the catalog does not list, and truncates a long one", () => {
      const remembered = "a-remembered-level-nobody-advertises-any-more";
      renderFooter(reasoningConfig(remembered, FOUR_OPTIONS, vi.fn()));

      expect(label().textContent).toBe(remembered);
      expect(label().className).toContain("truncate");
      expect(label().className).toContain("max-w-full");
      expect(thumb().getAttribute("aria-valuenow")).toBe("0");
      expect(thumb().getAttribute("aria-valuetext")).toBe(remembered);
    });

    it("leaves the list control without a label at all", () => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: "list",
        },
      });

      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(screen.queryByTestId("model-reasoning-level-name")).toBeNull();
    });
  });

  // The thick pill, and the geometry that has to move with it.
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

    it("asks the primitive for the pill size on the track and the thumb alike", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(track().getAttribute("data-size")).toBe("pill");
      expect(thumb().getAttribute("data-size")).toBe("pill");
      // The pill's own height is a LOCAL override (h-6, slimmer than the
      // primitive's own h-9 pill default), merged on top via `cn()` -
      // `cn` strips the primitive's conflicting class.
      expect(track().className).toContain("data-[size=pill]:h-6");
      expect(track().className).not.toContain("data-[size=pill]:h-9");
      expect(track().className).toContain("h-1");
      expect(thumb().className).toContain("data-[size=pill]:size-7");
      expect(thumb().className).toContain("size-4");
    });

    // A 1px border, not the primitive's own pill default (`border-2`) and not
    // borderless: zero border made the thumb read as one surface with the
    // track under a neutral/monochrome theme, so the local override restores
    // separation without the primitive's thicker ring. Token-exact match
    // (not `.toContain`) because "border" is also a literal substring of
    // "border-2" and "border-popover".
    it("restores a 1px thumb border over the primitive's own pill default", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const classes = thumb().className.split(/\s+/);
      expect(classes).toContain("data-[size=pill]:border");
      expect(classes).not.toContain("data-[size=pill]:border-2");
      expect(classes).not.toContain("data-[size=pill]:border-0");
      // The primitive's pill border COLOUR is untouched - only width conflicts.
      expect(classes).toContain("data-[size=pill]:border-popover");
    });

    // Radix parks the thumb's CENTRE half a thumb inside each end
    // (`getThumbInBoundsOffset`), so the overlay the stops are laid out in has
    // to be inset by exactly that - 14px for the 28px pill thumb.
    it("insets the stop overlay by half the pill thumb", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const overlay = stops().at(0)?.parentElement?.parentElement;
      expect(overlay?.className).toContain("px-3.5");
      // And matches the slider's own padding vertically, so the overlay is the
      // track's box rather than the padded row's.
      expect(overlay?.className).toContain("py-2");
      // No longer stacked above the thumb/badges - nothing here needs to win
      // a paint order fight any more.
      expect(overlay?.className).not.toContain("z-10");
      expect(screen.getByTestId("model-reasoning-slider").className).toContain(
        "py-2",
      );
    });

    it("gives each stop the track's full height and a coarse-pointer width", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      for (const stop of stops()) {
        expect(stop.className).toContain("h-full");
        expect(stop.className).toContain("w-5");
        expect(stop.className).toContain("pointer-coarse:w-6");
      }
    });

    it("colours a dot for the surface under it: fill to the left, base to the right", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

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

    it("fills solid up to the thumb", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const range = screen.getByTestId("model-reasoning-range");
      expect(range.className).toContain("bg-primary");
      expect(range.className).not.toContain("bg-primary/70");
    });

    it("draws a square covered edge - no rounded-full crescent between the range and the track", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(
        screen.getByTestId("model-reasoning-range").className,
      ).not.toContain("rounded-full");
    });

    it("insets the range's covered edge by the thumb-centre offset, scaled by position", () => {
      // FOUR_OPTIONS has lastIndex 3. `marginInlineEnd` interpolates linearly
      // from -0.875rem at the lowest stop to +0.875rem at the highest,
      // matching Radix's own thumb-centre inset at each end
      // (`getThumbInBoundsOffset`) instead of leaving the range on raw,
      // uninset percentages.
      const cases: ReadonlyArray<readonly [string, number]> = [
        ["low", -0.875],
        ["medium", -0.2916666666666666], // (2 * (1 / 3) - 1) * 0.875
        ["high", 0.2916666666666667], // (2 * (2 / 3) - 1) * 0.875
        ["max", 0.875],
      ];
      for (const [value, expectedRem] of cases) {
        cleanup();
        renderFooter(reasoningConfig(value, FOUR_OPTIONS, vi.fn()));
        const margin = parseFloat(
          screen.getByTestId("model-reasoning-range").style.marginInlineEnd,
        );
        expect(margin, value).toBeCloseTo(expectedRem, 6);
      }
    });

    it("insets by the magnetically-pulled preview position during a drag, not the raw pointer position", () => {
      const restore = stubSliderGeometry();
      try {
        renderStatefulFooter("low");
        const stop = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(stop, {
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          button: 0,
        });
        // 150 / 400 (stubbed track) * lastIndex(3) = 1.125 raw, pulled to
        // ~1.0953 by the (lastIndex-capped) magnetic pull.
        fireEvent.pointerMove(stop, {
          pointerId: 1,
          clientX: 150,
          clientY: 0,
          buttons: 1,
        });

        const pulledPosition = reasoningDragPosition(1.125, 3);
        const expectedMargin = ((2 * pulledPosition) / 3 - 1) * 0.875;
        const rawMargin = ((2 * 1.125) / 3 - 1) * 0.875;
        const margin = parseFloat(
          screen.getByTestId("model-reasoning-range").style.marginInlineEnd,
        );

        expect(margin).toBeCloseTo(expectedMargin, 6);
        expect(margin).not.toBeCloseTo(rawMargin, 4);
      } finally {
        restore();
      }
    });
  });

  it("falls back to the list for a model that advertises a single level", () => {
    renderFooter(
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

  it("renders the list, and no slider, under the `list` setting", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, reasoningFooterControl: "list" },
    });

    renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
    expect(screen.getByTestId("model-reasoning-scroller")).toBeDefined();
    for (const option of FOUR_OPTIONS) {
      expect(screen.getByRole("button", { name: option.label })).toBeDefined();
    }
  });

  it("keeps the thinking-effort group's name in either control", () => {
    renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

    expect(
      screen.getByRole("group", { name: "Thinking effort" }),
    ).not.toBeNull();
  });

  it("refuses every route while the model's levels are disabled", () => {
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

    fireEvent.click(screen.getByTestId("model-reasoning-stop-2"));
    fireEvent.keyDown(thumb(), { key: "ArrowRight" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // `data-dragging` is a LOCAL gesture read (raw pointer distance from
  // pointerdown, gated on a button actually being held) - separate from
  // Radix's own value-changing pointer math, which the drag tests above
  // already cover. It only flips `.reasoning-effort-slider[data-dragging]`'s
  // CSS (disables the travel transition mid-drag), so it is asserted here as
  // the `data-dragging` attribute rather than through a selection.
  describe("drag arming", () => {
    it("does not arm on jitter of 3px or less from pointerdown", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
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

    it("does not arm on a move reporting no button held", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
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

  // `useReasoningSliderGesture` previews the drag continuously (`step:
  // 0.001`, `value: [pointerValue ?? thumbIndex]`) so the thumb glides
  // instead of hopping between stops, but the ONLY thing ever handed to
  // `onChange` is `Math.round(position)` - a real catalog index.
  describe("continuous drag preview", () => {
    it("rounds every fractional pointer position to a real catalog level, never an invalid one", () => {
      // Stateful: `aria-valuenow` reads off the COMMITTED `value` prop
      // (`thumbIndex`), so a stateless footer would never re-render with the
      // rounded selection and this assertion would still see the pre-drag
      // level.
      const restore = stubSliderGeometry();
      try {
        const selections = renderStatefulFooter("low");
        const stop = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(stop, {
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          button: 0,
        });
        // 150 / 400 (stubbed track) * lastIndex(3) = 1.125 - a position with
        // no catalog entry at all - rounds to index 1 ("medium").
        fireEvent.pointerMove(stop, {
          pointerId: 1,
          clientX: 150,
          clientY: 0,
          buttons: 1,
        });

        expect(selections.length).toBeGreaterThan(0);
        const validIds = new Set(FOUR_OPTIONS.map((option) => option.id));
        for (const selection of selections) {
          expect(validIds.has(selection)).toBe(true);
        }
        expect(selections.at(-1)).toBe("medium");
        // The thumb's own announced value stays the rounded catalog index -
        // an explicit `aria-valuenow` override, since Radix would otherwise
        // announce the raw fractional preview value mid-drag.
        expect(thumb().getAttribute("aria-valuenow")).toBe("1");
      } finally {
        restore();
      }
    });

    it("settles to the whole level on release, and a subsequent arrow key still steps by exactly one level", () => {
      const restore = stubSliderGeometry();
      try {
        const selections = renderStatefulFooter("low");
        const stop = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(stop, {
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          button: 0,
        });
        fireEvent.pointerMove(stop, {
          pointerId: 1,
          clientX: 150,
          clientY: 0,
          buttons: 1,
        });
        fireEvent.pointerUp(stop, { pointerId: 1, clientX: 150, clientY: 0 });

        expect(selections.at(-1)).toBe("medium");
        expect(
          screen
            .getByTestId("model-reasoning-slider")
            .getAttribute("data-dragging"),
        ).toBeNull();

        fireEvent.keyDown(thumb(), { key: "ArrowRight" });

        // One whole level up from "medium" ("high") - not a fractional step,
        // and not the pre-drag "low" either.
        expect(selections.at(-1)).toBe("high");
      } finally {
        restore();
      }
    });

    it("keeps every dot visible mid-drag, hiding only the settled selection once released", () => {
      // `selected`/`overFill` compare against the CONTINUOUS `gesture.position`,
      // not the rounded committed index - so a dot the thumb has not visually
      // reached yet cannot be marked "selected" (and hidden) ahead of it.
      const restore = stubSliderGeometry();
      try {
        renderStatefulFooter("low");
        const stop = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(stop, {
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          button: 0,
        });
        // 1.125 - between stops 1 and 2, exactly equal to neither.
        fireEvent.pointerMove(stop, {
          pointerId: 1,
          clientX: 150,
          clientY: 0,
          buttons: 1,
        });

        for (let index = 0; index < FOUR_OPTIONS.length; index += 1) {
          expect(
            screen.getByTestId(`model-reasoning-dot-${index}`).className,
            `dot ${index} mid-drag`,
          ).not.toContain("opacity-0");
        }

        fireEvent.pointerUp(stop, { pointerId: 1, clientX: 150, clientY: 0 });

        // Settled on "medium" (index 1) - now exactly that dot hides.
        expect(screen.getByTestId("model-reasoning-dot-1").className).toContain(
          "opacity-0",
        );
        expect(
          screen.getByTestId("model-reasoning-dot-0").className,
        ).not.toContain("opacity-0");
      } finally {
        restore();
      }
    });

    it("resets the stale moved/active flags on a buttons-0 pointermove, so a later assistive click still selects", () => {
      // Without this reset, `movedByGesture()` (active && moved) would still
      // read true from the earlier drag and swallow the next click outright -
      // e.g. an assistive-technology activation that never goes through
      // pointerdown/pointerup at all.
      const restore = stubSliderGeometry();
      try {
        const onChange = vi.fn<(next: string) => void>();
        renderFooter(reasoningConfig("low", FOUR_OPTIONS, onChange));
        const stop0 = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(stop0, {
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          button: 0,
        });
        // A real drag, so Radix's `onValueChange` marks the gesture "moved".
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
      } finally {
        restore();
      }
    });

    it("previews a position pulled toward the nearest stop while still committing the raw rounded level", () => {
      // Ties the pure `reasoningDragPosition` math (unit-tested on its own in
      // use-reasoning-slider-gesture.test.ts) to this exact drag scenario:
      // the same 1.125 raw position the "rounds every fractional..." test
      // above commits as "medium".
      const restore = stubSliderGeometry();
      try {
        const selections = renderStatefulFooter("low");
        const stop = screen.getByTestId("model-reasoning-stop-0");

        fireEvent.pointerDown(stop, {
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          button: 0,
        });
        fireEvent.pointerMove(stop, {
          pointerId: 1,
          clientX: 150,
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
      } finally {
        restore();
      }
    });
  });

  describe("pressed state", () => {
    it("is set for the whole physical gesture and clears on release", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
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

    it("clears on pointercancel", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
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

    it("clears on losing pointer capture", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
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

    it("clears on a move reporting no button held", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
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
