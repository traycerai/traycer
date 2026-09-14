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
      fireEvent.pointerMove(start, { pointerId: 1, clientX: 400 });
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
      // The pill's own height, and the default's, both from the primitive.
      expect(track().className).toContain("data-[size=pill]:h-9");
      expect(track().className).toContain("h-1");
      expect(thumb().className).toContain("data-[size=pill]:size-7");
      expect(thumb().className).toContain("size-4");
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
      // `high` is index 2, so 0 and 1 are under the fill and 3 is not. The
      // selected stop is hidden under the thumb, whichever way it is painted.
      expect(dots[0]?.className).toContain("bg-primary-foreground/35");
      expect(dots[1]?.className).toContain("bg-primary-foreground/35");
      expect(dots[3]?.className).toContain("bg-foreground/25");
      expect(stops().at(2)?.className).toContain("opacity-0");
    });

    it("fills solid up to the thumb", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      const range = screen.getByTestId("model-reasoning-range");
      expect(range.className).toContain("bg-primary");
      expect(range.className).not.toContain("bg-primary/70");
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
});
