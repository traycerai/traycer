import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import type { ModelOption } from "@/components/home/data/landing-options";
import { HarnessModelPickerItem } from "@/components/home/pickers/harness-model-picker-item";
import { guiAgentModelCapabilitiesSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";

function model(overrides: Partial<ModelOption>): ModelOption {
  const base: ModelOption = {
    harnessId: "codex",
    slug: "gpt-image-test",
    label: "GPT Image Test",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: {},
  };
  return {
    ...base,
    ...overrides,
    metadata: overrides.metadata ?? base.metadata,
  };
}

function row(modelOption: ModelOption): HarnessModelRow {
  return {
    id: `${modelOption.harnessId}:${modelOption.slug}`,
    value: modelOption.slug,
    harnessId: modelOption.harnessId,
    harnessLabel: "Codex",
    label: modelOption.label,
    browseLabel: modelOption.label,
    providerGroupId: null,
    providerGroupLabel: null,
    capacityLabel: null,
    deprecationNotice: modelOption.deprecationNotice ?? null,
    model: modelOption,
    searchLabel: modelOption.label,
    searchSlug: modelOption.slug,
    searchProviderLabel: "Codex",
    searchProviderId: modelOption.harnessId,
    searchOpenCodeProviderLabel: "",
    searchOpenCodeProviderId: "",
  };
}

function renderItem(modelOption: ModelOption) {
  return render(
    <HarnessModelPickerItem
      idPrefix="picker"
      row={row(modelOption)}
      selected={false}
      active={false}
      showCapacity={false}
      onHover={vi.fn()}
      onActive={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("<HarnessModelPickerItem /> image generation capability", () => {
  it("keeps the capability in the row tooltip without rendering an Image badge", () => {
    // Fixture must round-trip through the shared capability schema - the
    // component uses guiAgentModelCapabilitiesSchema, not ad-hoc narrowing.
    const capabilities = guiAgentModelCapabilitiesSchema.parse({
      imageGeneration: true,
    });
    expect(capabilities.imageGeneration).toBe(true);

    renderItem(
      model({
        metadata: { capabilities },
      }),
    );

    expect(screen.queryByText("Image")).toBeNull();
    expect(screen.queryByLabelText("Supports image generation")).toBeNull();

    fireEvent.focus(screen.getByRole("option", { name: /GPT Image Test/ }));
    // Tooltip label is keyboard-reachable from the option itself.
    return screen.findByRole("tooltip").then((tooltip) => {
      expect(tooltip.textContent).toBe("Supports image generation");
    });
  });

  it("shows no Image marker when capabilities.imageGeneration is false", () => {
    const capabilities = guiAgentModelCapabilitiesSchema.parse({
      imageGeneration: false,
    });
    renderItem(model({ metadata: { capabilities } }));
    expect(screen.queryByLabelText("Supports image generation")).toBeNull();
    expect(screen.queryByText("Image")).toBeNull();
  });

  it("shows no Image marker when capabilities are absent", () => {
    expect(guiAgentModelCapabilitiesSchema.parse({}).imageGeneration).toBe(
      false,
    );
    renderItem(model({ metadata: {} }));
    expect(screen.queryByLabelText("Supports image generation")).toBeNull();
    expect(screen.queryByText("Image")).toBeNull();
  });
});
