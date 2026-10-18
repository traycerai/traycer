import { describe, expect, it, vi } from "vitest";
import { deriveHarnessModelPickerPresentation } from "@/components/home/pickers/harness-model-picker-presentation";
import type {
  HarnessModelSelection,
  ModelOption,
  ServiceTier,
} from "@/components/home/data/landing-options";

const SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "gpt-6.1-sol",
  profileId: null,
};

const SOL: ModelOption = {
  harnessId: "codex",
  slug: "gpt-6.1-sol",
  label: "GPT-6.1-Sol",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  defaultServiceTier: null,
  supportedServiceTiers: [
    { id: "priority", label: "Fast", description: null },
    { id: "ultrafast", label: "Ultrafast", description: null },
  ],
  metadata: {},
};

function presentationFor(value: ServiceTier, selectedModel: ModelOption) {
  return deriveHarnessModelPickerPresentation({
    selection: SELECTION,
    models: [],
    reasoningFooter: null,
    serviceTierFooter: { selectedModel, value, onChange: vi.fn() },
    harnessesPending: false,
    modelsPending: false,
    selectedHarnessAvailable: true,
    selectedHarnessProfiles: [],
  });
}

describe("deriveHarnessModelPickerPresentation › service tier", () => {
  it("names the selected tier for the trigger chip", () => {
    const presentation = presentationFor("ultrafast", SOL);

    expect(presentation.activeServiceTierLabel).toBe("Ultrafast");
    expect(presentation.serviceTierActive).toBe(true);
  });

  it("is inactive on Standard", () => {
    const presentation = presentationFor("", SOL);

    expect(presentation.activeServiceTierLabel).toBeNull();
    expect(presentation.serviceTierActive).toBe(false);
  });

  it("is inactive when the sticky tier is not advertised by the selected model", () => {
    const presentation = presentationFor("ultrafast", {
      ...SOL,
      supportedServiceTiers: [
        { id: "priority", label: "Fast", description: null },
      ],
    });

    expect(presentation.activeServiceTierLabel).toBeNull();
    expect(presentation.serviceTierActive).toBe(false);
  });
});
