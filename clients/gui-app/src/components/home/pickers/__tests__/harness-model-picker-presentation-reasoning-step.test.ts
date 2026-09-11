import { describe, expect, it, vi } from "vitest";
import {
  deriveHarnessModelPickerPresentation,
  formatReasoningPosition,
} from "@/components/home/pickers/harness-model-picker-presentation";
import type { ReasoningFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";

const SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "gpt-5.5",
  profileId: null,
};

const OPTIONS = [
  { id: "low", label: "Low", description: null },
  { id: "medium", label: "Medium", description: null },
  { id: "high", label: "High", description: null },
] as const;

// pi's shape: a no-thinking level first, then six graded ones. The ladder the
// glyph draws is the six; `off` is an OFF state, not its bottom rung.
const PI_OPTIONS = [
  { id: "off", label: "Off", description: null },
  { id: "low", label: "Low", description: null },
  { id: "medium", label: "Medium", description: null },
  { id: "high", label: "High", description: null },
  { id: "very-high", label: "Very High", description: null },
  { id: "max", label: "Max", description: null },
  { id: "ultra", label: "Ultra", description: null },
] as const;

function presentationFor(reasoningFooter: ReasoningFooterConfig | null) {
  return deriveHarnessModelPickerPresentation({
    selection: SELECTION,
    models: [],
    reasoningFooter,
    serviceTierFooter: null,
    harnessesPending: false,
    modelsPending: false,
    selectedHarnessAvailable: true,
    selectedHarnessProfiles: [],
  });
}

describe("deriveHarnessModelPickerPresentation › reasoningStep", () => {
  it("places the current level by its catalog order, 0-based", () => {
    const presentation = presentationFor({
      value: "medium",
      options: OPTIONS,
      disabled: false,
      onChange: vi.fn(),
    });

    expect(presentation.reasoningLabel).toBe("Medium");
    expect(presentation.reasoningStep).toEqual({ index: 1, count: 3 });
    expect(formatReasoningPosition({ index: 1, count: 3 })).toBe("2 of 3");
  });

  it("reports an unknown position, with the raw value as the label, when the value names none of the levels", () => {
    const presentation = presentationFor({
      value: "xhigh",
      options: OPTIONS,
      disabled: false,
      onChange: vi.fn(),
    });

    expect(presentation.reasoningLabel).toBe("xhigh");
    expect(presentation.reasoningStep).toEqual({ index: null, count: 3 });
    expect(formatReasoningPosition({ index: null, count: 3 })).toBeNull();
  });

  it("keeps a no-thinking level off the ladder and lights none of it", () => {
    const presentation = presentationFor({
      value: "off",
      options: PI_OPTIONS,
      disabled: false,
      onChange: vi.fn(),
    });

    expect(presentation.reasoningLabel).toBe("Off");
    expect(presentation.reasoningStep).toEqual({ index: null, count: 6 });
  });

  it("counts the bottom graded level as the first of six on that catalog", () => {
    const presentation = presentationFor({
      value: "low",
      options: PI_OPTIONS,
      disabled: false,
      onChange: vi.fn(),
    });

    expect(presentation.reasoningLabel).toBe("Low");
    expect(presentation.reasoningStep).toEqual({ index: 0, count: 6 });
    expect(formatReasoningPosition({ index: 0, count: 6 })).toBe("1 of 6");
  });

  // amp advertises its ladder with no zero-effort entry at all, so nothing is
  // dropped and every level keeps the position the catalog gives it.
  it("drops nothing from a catalog that has no zero-effort level", () => {
    const presentation = presentationFor({
      value: "high",
      options: OPTIONS,
      disabled: false,
      onChange: vi.fn(),
    });

    expect(presentation.reasoningStep).toEqual({ index: 2, count: 3 });
  });

  it.each([
    ["no footer", null],
    [
      "a model with no levels",
      { value: "high", options: [], disabled: true, onChange: vi.fn() },
    ],
  ] as const)("is null, with the label, for %s", (_label, reasoningFooter) => {
    const presentation = presentationFor(reasoningFooter);

    expect(presentation.reasoningLabel).toBeNull();
    expect(presentation.reasoningStep).toBeNull();
  });

  // Nothing graded to draw: the chip falls back to the level's name, which is
  // why the trigger treats a null step as text mode rather than an empty box.
  it("is null, with the label kept, when every level is a zero-effort one", () => {
    const presentation = presentationFor({
      value: "none",
      options: [
        { id: "off", label: "Off", description: null },
        { id: "none", label: "None", description: null },
      ],
      disabled: false,
      onChange: vi.fn(),
    });

    expect(presentation.reasoningLabel).toBe("None");
    expect(presentation.reasoningStep).toBeNull();
  });
});
