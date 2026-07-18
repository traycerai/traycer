import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  rateLimitScopeAffectsModel,
  rateLimitSeverityTier,
} from "../rate-limit-scope-match";

function model(slug: string, label: string): ModelOption {
  return {
    harnessId: "claude",
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

describe("rateLimitScopeAffectsModel", () => {
  it("treats a shared (null-family) scope as gating every model", () => {
    expect(rateLimitScopeAffectsModel(null, model("opus[1m]", "Opus"))).toBe(
      true,
    );
    expect(rateLimitScopeAffectsModel(null, model("haiku", "Haiku"))).toBe(
      true,
    );
  });

  it("matches provider family tokens against real catalog slugs", () => {
    const opus = model("opus[1m]", "Opus");
    const fable = model("claude-fable-5[1m]", "Fable");
    const sonnet = model("sonnet", "Sonnet");
    const versionedOpus = model("claude-opus-4-7", "Claude Opus 4.7");

    expect(rateLimitScopeAffectsModel("opus", opus)).toBe(true);
    expect(rateLimitScopeAffectsModel("opus", versionedOpus)).toBe(true);
    expect(rateLimitScopeAffectsModel("Fable", fable)).toBe(true);
    expect(rateLimitScopeAffectsModel("sonnet", sonnet)).toBe(true);

    expect(rateLimitScopeAffectsModel("Fable", opus)).toBe(false);
    expect(rateLimitScopeAffectsModel("opus", fable)).toBe(false);
    expect(rateLimitScopeAffectsModel("sonnet", opus)).toBe(false);
  });

  it("leaves a model with no scoped bucket unmatched by every named family", () => {
    const haiku = model("haiku", "Haiku");
    expect(rateLimitScopeAffectsModel("opus", haiku)).toBe(false);
    expect(rateLimitScopeAffectsModel("sonnet", haiku)).toBe(false);
    expect(rateLimitScopeAffectsModel("Fable", haiku)).toBe(false);
  });

  it("ignores numeric version tokens instead of cross-matching them", () => {
    // "Fable 5"'s "5" must not match claude-opus-4-5-style slugs.
    expect(
      rateLimitScopeAffectsModel("Fable 5", model("claude-opus-4-5", "Opus")),
    ).toBe(false);
    expect(
      rateLimitScopeAffectsModel(
        "Fable 5",
        model("claude-fable-5[1m]", "Fable"),
      ),
    ).toBe(true);
  });

  it("errs toward matching when a family carries no alphabetic token", () => {
    expect(rateLimitScopeAffectsModel("5", model("opus[1m]", "Opus"))).toBe(
      true,
    );
    expect(rateLimitScopeAffectsModel("--", model("opus[1m]", "Opus"))).toBe(
      true,
    );
  });
});

describe("rateLimitSeverityTier", () => {
  it("orders not-limited < near_limit < hard_limit", () => {
    expect(rateLimitSeverityTier(null)).toBeLessThan(
      rateLimitSeverityTier("near_limit"),
    );
    expect(rateLimitSeverityTier("near_limit")).toBeLessThan(
      rateLimitSeverityTier("hard_limit"),
    );
  });
});
