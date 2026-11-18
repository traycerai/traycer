import { describe, expect, it, vi } from "vitest";
import type { GuiAgentModelOption } from "@traycer/protocol/host";
import {
  nonDefaultServiceTiersForModel,
  normalizeServiceTierForModel,
  selectedServiceTierOption,
  serviceTierControlForModel,
  standardServiceTierLabel,
  type ModelOption,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { stepServiceTier } from "@/components/home/pickers/model-service-tier";

const FAST = { id: "priority", label: "Fast", description: "2x speed" };
const ULTRAFAST = {
  id: "ultrafast",
  label: "Ultrafast",
  description: "The fastest available responses.",
};

function model(
  slug: string,
  supportedServiceTiers: GuiAgentModelOption["supportedServiceTiers"],
  defaultServiceTier: string | null,
): ModelOption {
  return {
    harnessId: "codex",
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier,
    supportedServiceTiers,
    metadata: {},
  };
}

const SOL = model("gpt-6.1-sol", [FAST, ULTRAFAST], null);
const ASTRA_PRIORITY_ONLY = model("gpt-6-sol", [FAST], null);
const NO_TIERS = model("gpt-5", [], null);

describe("nonDefaultServiceTiersForModel / serviceTierControlForModel", () => {
  it("is none for a null model and a model without tiers", () => {
    expect(nonDefaultServiceTiersForModel(null)).toEqual([]);
    expect(serviceTierControlForModel(null)).toBe("none");
    expect(serviceTierControlForModel(NO_TIERS)).toBe("none");
  });

  it("is a toggle for exactly one non-default tier", () => {
    expect(nonDefaultServiceTiersForModel(ASTRA_PRIORITY_ONLY)).toEqual([FAST]);
    expect(serviceTierControlForModel(ASTRA_PRIORITY_ONLY)).toBe("toggle");
  });

  it("is a menu in advertised order for several tiers", () => {
    expect(
      nonDefaultServiceTiersForModel(SOL).map((option) => option.id),
    ).toEqual(["priority", "ultrafast"]);
    expect(serviceTierControlForModel(SOL)).toBe("menu");
  });

  it("drops the declared default tier and de-duplicates by id", () => {
    const withDefault = model(
      "m",
      [{ id: "default", label: "Default", description: null }, FAST, FAST],
      "default",
    );
    expect(nonDefaultServiceTiersForModel(withDefault)).toEqual([FAST]);
    expect(serviceTierControlForModel(withDefault)).toBe("toggle");
  });

  it("offers no upgrade when a model advertises only its default", () => {
    const onlyDefault = model("m", [FAST], "priority");
    expect(nonDefaultServiceTiersForModel(onlyDefault)).toEqual([]);
    expect(serviceTierControlForModel(onlyDefault)).toBe("none");
  });
});

describe("normalizeServiceTierForModel", () => {
  it("keeps ultrafast on a model that advertises it and clears it elsewhere", () => {
    expect(normalizeServiceTierForModel("ultrafast", SOL)).toBe("ultrafast");
    expect(normalizeServiceTierForModel("ultrafast", ASTRA_PRIORITY_ONLY)).toBe(
      "",
    );
    expect(normalizeServiceTierForModel("priority", NO_TIERS)).toBe("");
  });

  it("never substitutes a different paid tier", () => {
    expect(normalizeServiceTierForModel("fast", SOL)).toBe("");
  });

  it("passes the value through while the model is unresolved", () => {
    expect(normalizeServiceTierForModel("ultrafast", null)).toBe("ultrafast");
  });

  it("is sticky: the raw preference re-applies when the advertising model returns", () => {
    const raw: ServiceTier = "ultrafast";
    expect(normalizeServiceTierForModel(raw, ASTRA_PRIORITY_ONLY)).toBe("");
    expect(normalizeServiceTierForModel(raw, SOL)).toBe("ultrafast");
  });
});

describe("selectedServiceTierOption / standardServiceTierLabel", () => {
  it("returns the matching option, or null for Standard and foreign tiers", () => {
    expect(selectedServiceTierOption("ultrafast", SOL)).toEqual(ULTRAFAST);
    expect(selectedServiceTierOption("", SOL)).toBeNull();
    expect(
      selectedServiceTierOption("ultrafast", ASTRA_PRIORITY_ONLY),
    ).toBeNull();
  });

  it("names Standard unless the model advertises its own default tier", () => {
    expect(standardServiceTierLabel(SOL)).toBe("Standard");
    expect(standardServiceTierLabel(null)).toBe("Standard");
    const named = model(
      "m",
      [{ id: "flex", label: "Flex", description: null }, FAST],
      "flex",
    );
    expect(standardServiceTierLabel(named)).toBe("Flex");
  });
});

describe("stepServiceTier", () => {
  function step(value: ServiceTier, selectedModel: ModelOption | null) {
    const onChange = vi.fn();
    const handled = stepServiceTier({ selectedModel, value, onChange });
    return { handled, onChange };
  }

  it("steps Standard, Fast, Ultrafast, Standard on a dual-tier model", () => {
    expect(step("", SOL).onChange).toHaveBeenCalledWith("priority");
    expect(step("priority", SOL).onChange).toHaveBeenCalledWith("ultrafast");
    expect(step("ultrafast", SOL).onChange).toHaveBeenCalledWith("");
  });

  it("toggles on a single-tier model", () => {
    expect(step("", ASTRA_PRIORITY_ONLY).onChange).toHaveBeenCalledWith(
      "priority",
    );
    expect(step("priority", ASTRA_PRIORITY_ONLY).onChange).toHaveBeenCalledWith(
      "",
    );
  });

  it("treats a sticky tier the model lacks as Standard", () => {
    expect(
      step("ultrafast", ASTRA_PRIORITY_ONLY).onChange,
    ).toHaveBeenCalledWith("priority");
  });

  it("does nothing without a config or without tiers", () => {
    expect(stepServiceTier(null)).toBe(false);
    const result = step("", NO_TIERS);
    expect(result.handled).toBe(false);
    expect(result.onChange).not.toHaveBeenCalled();
  });
});
