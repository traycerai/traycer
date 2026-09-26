import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TierCandidate } from "@traycer/protocol/host/fallback-policy";
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";
import {
  FallbackModelPatternCombobox,
  type FallbackModelPatternComboboxProps,
} from "@/components/settings/panels/fallback/fallback-model-pattern-combobox";

afterEach(() => {
  cleanup();
});

function model(slug: string, label: string): GuiAgentModelOption {
  return {
    harnessId: "codex",
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

const CODEX_CATALOG: readonly GuiAgentModelOption[] = [
  model("gpt-6-astra", "GPT-6-Astra"),
  model("gpt-6-sol", "GPT-6-Sol"),
  model("gpt-5.6-terra", "GPT-5.6-Terra"),
];

const TERRA_ROW: TierCandidate = {
  harnessId: "codex",
  modelFamily: "gpt-5.6-terra",
  reasoningEffort: null,
};

function props(
  models: readonly GuiAgentModelOption[] | null,
  onChange: (next: string) => void,
): FallbackModelPatternComboboxProps {
  return {
    id: "row-model",
    rowKey: "row-1",
    modelFamily: TERRA_ROW.modelFamily,
    harnessId: "codex",
    providerLabel: "Codex",
    models,
    groups: [{ id: "standard", candidates: [TERRA_ROW] }],
    groupIndex: 0,
    candidateIndex: 0,
    conflictCount: 0,
    describedBy: undefined,
    onChange,
    onAnnounce: vi.fn(),
  };
}

/**
 * R7 (review round 1): the provider's catalog ANSWERS while the picker is
 * already open on an exact-pick row.
 *
 * Opened cold, the picker cannot tell `gpt-5.6-terra` is a model - there is
 * no catalog to find it in - so the stored value becomes the query and the
 * highlight lands on the only option there is, the "contains" pattern. When
 * the catalog lands the exact model moves to the top, and the Enter rule
 * (spec §Wireframe 2: an exact ID puts that model first, so Enter picks it)
 * has to hold: Enter saves the SLUG, never `*gpt-5.6-terra*`, which would
 * silently turn a one-model row into a pattern.
 */
describe("FallbackModelPatternCombobox - a catalog that arrives while open", () => {
  it("Enter picks the exact model once the catalog lands, not the pattern the cold open highlighted", () => {
    const onChange = vi.fn();
    const view = render(
      <FallbackModelPatternCombobox {...props(null, onChange)} />,
    );
    fireEvent.click(screen.getByTestId("fallback-model-pattern-trigger"));

    view.rerender(
      <FallbackModelPatternCombobox {...props(CODEX_CATALOG, onChange)} />,
    );

    fireEvent.keyDown(screen.getByTestId("fallback-model-pattern-input"), {
      key: "Enter",
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("gpt-5.6-terra");
  });
});
