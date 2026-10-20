import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessModelPickerModelSettingsFooter,
  type ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type {
  ModelOption,
  ServiceTier,
} from "@/components/home/data/landing-options";

const FAST_DESCRIPTION = "2x speed, increased usage";
const ULTRAFAST_DESCRIPTION =
  "The fastest available responses for latency-sensitive work.";

function model(tiers: ModelOption["supportedServiceTiers"]): ModelOption {
  return {
    harnessId: "codex",
    slug: "gpt-6.1-sol",
    label: "GPT-6.1-Sol",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: tiers,
    metadata: {},
  };
}

const DUAL = model([
  { id: "priority", label: "Fast", description: FAST_DESCRIPTION },
  { id: "ultrafast", label: "Ultrafast", description: ULTRAFAST_DESCRIPTION },
]);
const SINGLE = model([
  { id: "priority", label: "Fast", description: FAST_DESCRIPTION },
]);

function renderFooter(selectedModel: ModelOption, value: ServiceTier) {
  const onChange = vi.fn<(next: ServiceTier) => void>();
  const config: ServiceTierFooterConfig = { selectedModel, value, onChange };
  render(
    <HarnessModelPickerModelSettingsFooter
      pickerOpen
      reasoning={null}
      serviceTier={config}
    />,
  );
  return { onChange };
}

function openMenu(name: string | RegExp): void {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

afterEach(cleanup);

describe("service tier footer control", () => {
  it("keeps the Fast mode toggle for one tier and renders no menu", () => {
    renderFooter(SINGLE, "");

    expect(screen.getByRole("button", { name: "Fast mode" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Speed/ })).toBeNull();
  });

  it("renders nothing for a model with no tiers", () => {
    renderFooter(model([]), "");

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a Speed menu for several tiers instead of the toggle", () => {
    renderFooter(DUAL, "");

    expect(screen.queryByRole("button", { name: "Fast mode" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Speed: Standard" }),
    ).not.toBeNull();
  });

  it("lists Standard plus each tier with its advertised description verbatim", () => {
    renderFooter(DUAL, "ultrafast");
    openMenu("Speed: Ultrafast");

    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Standard",
      `Fast${FAST_DESCRIPTION}`,
      `Ultrafast${ULTRAFAST_DESCRIPTION}`,
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });

  it("reports the chosen id, and an empty string for Standard", () => {
    const { onChange } = renderFooter(DUAL, "priority");
    openMenu("Speed: Fast");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Ultrafast/ }));
    expect(onChange).toHaveBeenLastCalledWith("ultrafast");

    openMenu("Speed: Fast");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Standard" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("shows Standard when the sticky tier is not advertised by this model", () => {
    renderFooter(
      model([
        { id: "priority", label: "Fast", description: null },
        { id: "flex", label: "Flex", description: null },
      ]),
      "ultrafast",
    );

    expect(
      screen.getByRole("button", { name: "Speed: Standard" }),
    ).not.toBeNull();
  });

  it("shows only the name for a tier without a description", () => {
    renderFooter(
      model([
        { id: "priority", label: "Fast", description: null },
        { id: "ultrafast", label: "Ultrafast", description: null },
      ]),
      "",
    );
    openMenu("Speed: Standard");

    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(["Standard", "Fast", "Ultrafast"]);
  });
});
