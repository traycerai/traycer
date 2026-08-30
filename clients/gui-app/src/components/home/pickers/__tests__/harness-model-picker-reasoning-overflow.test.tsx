import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
  type ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type {
  ModelOption,
  ReasoningLevelOption,
} from "@/components/home/data/landing-options";

// Harness-reported reasoning levels are unbounded (some harnesses advertise
// many more than a footer row can lay out side by side), so the fixture
// intentionally carries more options than a narrow strip could show at once.
const SEVEN_OPTIONS: ReadonlyArray<ReasoningLevelOption> = [
  { id: "minimal", label: "Minimal", description: null },
  { id: "low", label: "Low", description: null },
  { id: "medium", label: "Medium", description: null },
  { id: "high", label: "High", description: null },
  { id: "extra-high", label: "Extra High", description: null },
  { id: "max", label: "Max", description: null },
  { id: "ultra", label: "Ultra", description: null },
];

// A model whose service tiers resolve to a single "Fast" upgrade over its
// declared default - the shape `findUpgradeServiceTierForModel` needs to
// surface the footer's Fast toggle.
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

function reasoningConfig(
  value: string,
  options: ReadonlyArray<ReasoningLevelOption>,
  onChange: (next: string) => void,
): ReasoningFooterConfig {
  return { value, options, disabled: false, onChange };
}

function serviceTierConfig(
  selectedModel: ModelOption,
  value: string,
  onChange: (next: string) => void,
): ServiceTierFooterConfig {
  return { selectedModel, value, onChange };
}

describe("<HarnessModelPickerModelSettingsFooter /> reasoning overflow", () => {
  afterEach(() => cleanup());

  it("renders and lets you select every harness-reported level even when more levels exist than fit in a narrow row", () => {
    const onChange = vi.fn<(next: string) => void>();
    render(
      <div style={{ width: "140px" }}>
        <HarnessModelPickerModelSettingsFooter
          reasoning={reasoningConfig("minimal", SEVEN_OPTIONS, onChange)}
          serviceTier={null}
        />
      </div>,
    );

    const scroller = screen.getByTestId("model-reasoning-scroller");
    for (const option of SEVEN_OPTIONS) {
      const button = screen.getByRole("button", { name: option.label });
      expect(scroller.contains(button)).toBe(true);
    }

    fireEvent.click(screen.getByRole("button", { name: "Ultra" }));
    expect(onChange).toHaveBeenCalledWith("ultra");
  });

  it("is a real horizontal scroller whose inner row keeps the even spread until it overflows", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("low", SEVEN_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );

    const scroller = screen.getByTestId("model-reasoning-scroller");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("no-scrollbar");

    const optionsRow = scroller.firstElementChild;
    if (optionsRow === null) throw new Error("Expected an options row");
    expect(optionsRow.className).toContain("w-max");
    expect(optionsRow.className).toContain("min-w-full");
  });

  it("scrolls the selected level into view on mount", () => {
    const scrollTargets: Element[] = [];
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrollTargets.push(this);
      });
    try {
      render(
        <HarnessModelPickerModelSettingsFooter
          reasoning={reasoningConfig("ultra", SEVEN_OPTIONS, vi.fn())}
          serviceTier={null}
        />,
      );

      const selectedButton = screen.getByRole("button", { name: "Ultra" });
      expect(scrollTargets).toContain(selectedButton);
      expect(scrollSpy).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest",
      });
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("shows no edge fade when the strip does not overflow its scroller", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("low", SEVEN_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );
    const scroller = screen.getByTestId("model-reasoning-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 200 },
      scrollLeft: { configurable: true, value: 0 },
    });
    fireEvent.scroll(scroller);

    expect(scroller.className).not.toContain("mask-image");
  });

  it("fades only the right edge when an overflowing strip is scrolled to its start", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("low", SEVEN_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );
    const scroller = screen.getByTestId("model-reasoning-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, value: 0 },
    });
    fireEvent.scroll(scroller);

    expect(scroller.className).toContain(
      "linear-gradient(to_right,black_calc(100%-1.5rem),transparent)",
    );
    expect(scroller.className).not.toContain(
      "linear-gradient(to_right,transparent,black_1.5rem)",
    );
  });

  it("fades only the left edge when an overflowing strip is scrolled to its end", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("low", SEVEN_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );
    const scroller = screen.getByTestId("model-reasoning-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, value: 300 },
    });
    fireEvent.scroll(scroller);

    expect(scroller.className).toContain(
      "linear-gradient(to_right,transparent,black_1.5rem)",
    );
    expect(scroller.className).not.toContain(
      "linear-gradient(to_right,black_calc(100%-1.5rem),transparent)",
    );
  });

  it("fades both edges when an overflowing strip is scrolled to its middle", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("low", SEVEN_OPTIONS, vi.fn())}
        serviceTier={null}
      />,
    );
    const scroller = screen.getByTestId("model-reasoning-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, value: 150 },
    });
    fireEvent.scroll(scroller);

    expect(scroller.className).toContain(
      "linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)",
    );
  });

  it("keeps the Fast service-tier toggle and its divider outside the reasoning scroller", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("low", SEVEN_OPTIONS, vi.fn())}
        serviceTier={serviceTierConfig(FAST_MODEL, "", vi.fn())}
      />,
    );

    const scroller = screen.getByTestId("model-reasoning-scroller");
    const fastButton = screen.getByRole("button", { name: "Fast mode" });
    expect(scroller.contains(fastButton)).toBe(false);
  });

  it("wires the scroller when a model with levels replaces one that reported none", () => {
    const { rerender } = render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("", [], vi.fn())}
        serviceTier={serviceTierConfig(FAST_MODEL, "", vi.fn())}
      />,
    );
    // The footer stays mounted across the swap because the Fast toggle keeps it
    // on screen - only the effort strip appears.
    expect(screen.queryByTestId("model-reasoning-scroller")).toBeNull();

    rerender(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("minimal", SEVEN_OPTIONS, vi.fn())}
        serviceTier={serviceTierConfig(FAST_MODEL, "", vi.fn())}
      />,
    );

    const scroller = screen.getByTestId("model-reasoning-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, value: 0 },
    });
    fireEvent.scroll(scroller);

    expect(scroller.className).toContain(
      "linear-gradient(to_right,black_calc(100%-1.5rem),transparent)",
    );
  });

  it("does not render the thinking-effort group when the model reports no reasoning levels", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        reasoning={reasoningConfig("", [], vi.fn())}
        serviceTier={serviceTierConfig(FAST_MODEL, "", vi.fn())}
      />,
    );

    expect(screen.queryByRole("group", { name: "Thinking effort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fast mode" })).toBeDefined();
  });
});
