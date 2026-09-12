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
      reasoningMax={null}
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
        reasoningMax={null}
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
    // The name is beside the track too, so the dots never stand alone.
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

  it("moves the name beside the track when the level changes", () => {
    const { rerender } = render(
      <HarnessModelPickerModelSettingsFooter
        reasoningMax={null}
        reasoning={reasoningConfig("low", FOUR_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );
    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "Low",
    );

    rerender(
      <HarnessModelPickerModelSettingsFooter
        reasoningMax={null}
        reasoning={reasoningConfig("max", FOUR_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );

    expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
      "Max",
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("3");
  });

  // The track may not move when the name beside it does: the label cell holds
  // the width of the WIDEST name in the catalog, so every stop keeps its
  // position for the model's whole ladder.
  describe("fixed-width level label", () => {
    function sizers(): ReadonlyArray<HTMLElement> {
      return screen.getAllByTestId("model-reasoning-level-sizer");
    }

    it("reserves one sizer per catalog level, whichever level is selected", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));

      expect(sizers().map((sizer) => sizer.textContent)).toEqual([
        "Low",
        "Medium",
        "High",
        "Max",
      ]);
    });

    it("shows only the selected name and hides the sizers from sight and from AT", () => {
      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      for (const sizer of sizers()) {
        expect(sizer.classList.contains("invisible")).toBe(true);
        expect(sizer.getAttribute("aria-hidden")).toBe("true");
      }

      const name = screen.getByTestId("model-reasoning-level-name");
      expect(name.textContent).toBe("High");
      expect(name.classList.contains("invisible")).toBe(false);
      expect(name.getAttribute("aria-hidden")).toBeNull();
    });

    // The width comes from the cell, not from the class list: if the selected
    // level could change either, it could change the width.
    it("gives the label cell the same classes at the first level as at the last", () => {
      renderFooter(reasoningConfig("low", FOUR_OPTIONS, vi.fn()));
      const atFirst = screen.getByTestId(
        "model-reasoning-level-name",
      ).className;
      const firstSizers = sizers().map((sizer) => sizer.className);
      cleanup();

      renderFooter(reasoningConfig("max", FOUR_OPTIONS, vi.fn()));

      expect(screen.getByTestId("model-reasoning-level-name").className).toBe(
        atFirst,
      );
      expect(sizers().map((sizer) => sizer.className)).toEqual(firstSizers);
    });

    it("keeps the reserved set intact across a level change, name and value with it", () => {
      const { rerender } = render(
        <HarnessModelPickerModelSettingsFooter
          reasoningMax={null}
          reasoning={reasoningConfig("low", FOUR_OPTIONS, vi.fn())}
          serviceTier={null}
        />,
      );
      const before = sizers().map((sizer) => sizer.textContent);

      rerender(
        <HarnessModelPickerModelSettingsFooter
          reasoningMax={null}
          reasoning={reasoningConfig("max", FOUR_OPTIONS, vi.fn())}
          serviceTier={null}
        />,
      );

      expect(sizers().map((sizer) => sizer.textContent)).toEqual(before);
      expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
        "Max",
      );
      expect(thumb().getAttribute("aria-valuetext")).toBe("Max");
    });

    // A remembered level from another model still prints its raw id, which has
    // no sizer of its own - so the visible node cannot be one of the sizers.
    it("still names a level the catalog does not list", () => {
      renderFooter(reasoningConfig("ultra", FOUR_OPTIONS, vi.fn()));

      expect(screen.getByTestId("model-reasoning-level-name").textContent).toBe(
        "ultra",
      );
      expect(sizers()).toHaveLength(FOUR_OPTIONS.length);
      expect(thumb().getAttribute("aria-valuenow")).toBe("0");
      expect(thumb().getAttribute("aria-valuetext")).toBe("ultra");
    });

    // The other end of the same problem: a raw id LONGER than every catalog
    // label would widen an in-flow name node, and selecting a real level again
    // would shrink it - the movement the sizers exist to prevent, arriving by
    // the one name they do not reserve for. So the name is out of flow and the
    // cell is measured from the sizers alone.
    it("is not widened by an unknown level whose raw id is longer than every label", () => {
      const remembered = "a-remembered-level-nobody-advertises-any-more";
      const { rerender } = render(
        <HarnessModelPickerModelSettingsFooter
          reasoningMax={null}
          reasoning={reasoningConfig(remembered, FOUR_OPTIONS, vi.fn())}
          serviceTier={null}
        />,
      );
      const name = screen.getByTestId("model-reasoning-level-name");
      // Out of flow, so it contributes nothing to the grid's intrinsic width
      // and can only truncate inside it.
      expect(name.className).toContain("absolute");
      expect(name.className).toContain("truncate");
      expect(name.textContent).toBe(remembered);
      const cell = name.parentElement;
      const structure = {
        cell: cell?.className,
        name: name.className,
        sizers: sizers().map((sizer) => sizer.className),
        texts: sizers().map((sizer) => sizer.textContent),
      };

      rerender(
        <HarnessModelPickerModelSettingsFooter
          reasoningMax={null}
          reasoning={reasoningConfig("low", FOUR_OPTIONS, vi.fn())}
          serviceTier={null}
        />,
      );

      const after = screen.getByTestId("model-reasoning-level-name");
      expect({
        cell: after.parentElement?.className,
        name: after.className,
        sizers: sizers().map((sizer) => sizer.className),
        texts: sizers().map((sizer) => sizer.textContent),
      }).toEqual(structure);
      expect(after.textContent).toBe("Low");
    });

    it("leaves the list control without a label cell at all", () => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: "list",
        },
      });

      renderFooter(reasoningConfig("high", FOUR_OPTIONS, vi.fn()));

      expect(screen.queryByTestId("model-reasoning-level-name")).toBeNull();
      expect(screen.queryAllByTestId("model-reasoning-level-sizer")).toEqual(
        [],
      );
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
        reasoningMax={null}
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
