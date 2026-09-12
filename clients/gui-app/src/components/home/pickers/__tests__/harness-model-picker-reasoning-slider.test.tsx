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
