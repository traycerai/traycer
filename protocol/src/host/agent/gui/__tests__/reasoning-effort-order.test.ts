import { describe, expect, it } from "vitest";

import {
  effectiveJudgeReasoningEffort,
  sortReasoningEffortOptions,
} from "../reasoning-effort-order";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "../unary-schemas";

/** A reasoning-effort option, with a distinguishable label by default. */
function effort(id: string, label: string | null): AgentReasoningEffortOption {
  return { id, label: label ?? id, description: null };
}

/**
 * Minimal row builder, mirroring `model-slug-resolution.test.ts`'s own
 * fixture: only the fields the functions under test actually read matter
 * (slug, metadata.resolvedModel, supportedReasoningEfforts), the rest are
 * schema-shaped placeholders so fixtures stay valid GuiAgentModelOption
 * values.
 */
function model(
  slug: string,
  resolvedModel: string | null,
  supportedReasoningEfforts: ReadonlyArray<AgentReasoningEffortOption>,
): GuiAgentModelOption {
  const metadata: Record<string, unknown> =
    resolvedModel === null ? {} : { resolvedModel };
  return {
    harnessId: "claude",
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [...supportedReasoningEfforts],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata,
  };
}

describe("sortReasoningEffortOptions", () => {
  it("sorts a Grok-shaped xhigh-first input into the canonical low-to-high ladder", () => {
    const input = [
      effort("xhigh", null),
      effort("low", null),
      effort("high", null),
      effort("medium", null),
    ];
    expect(sortReasoningEffortOptions(input).map((o) => o.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("sorts the full ladder including off/minimal and max", () => {
    const input = [
      effort("max", null),
      effort("off", null),
      effort("high", null),
      effort("minimal", null),
      effort("low", null),
      effort("medium", null),
      effort("xhigh", null),
    ];
    expect(sortReasoningEffortOptions(input).map((o) => o.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("keeps unknown ids trailing the known ladder in their original relative order", () => {
    const input = [
      effort("mystery-b", null),
      effort("high", null),
      effort("mystery-a", null),
      effort("low", null),
    ];
    expect(sortReasoningEffortOptions(input).map((o) => o.id)).toEqual([
      "low",
      "high",
      "mystery-b",
      "mystery-a",
    ]);
  });

  it("is a stable sort - ties (two unknown ids, or two ids ranking equal) keep input order", () => {
    const first = effort("mystery", "First");
    const second = effort("mystery", "Second");
    const input = [first, second];
    expect(sortReasoningEffortOptions(input)).toEqual([first, second]);
  });

  it("does not mutate the input array", () => {
    const input = [effort("high", null), effort("low", null)];
    const copy = [...input];
    sortReasoningEffortOptions(input);
    expect(input).toEqual(copy);
  });
});

describe("effectiveJudgeReasoningEffort", () => {
  it("returns null when no row matches the slug", () => {
    const models: readonly GuiAgentModelOption[] = [
      model("sonnet", null, [effort("low", null)]),
    ];
    expect(
      effectiveJudgeReasoningEffort(models, "gone-model", null),
    ).toBeNull();
  });

  it("returns null when the matched row advertises no reasoning efforts", () => {
    const models: readonly GuiAgentModelOption[] = [model("sonnet", null, [])];
    expect(effectiveJudgeReasoningEffort(models, "sonnet", null)).toBeNull();
  });

  it("returns the requested option when the row advertises it", () => {
    const high = effort("high", null);
    const models: readonly GuiAgentModelOption[] = [
      model("sonnet", null, [
        effort("low", null),
        high,
        effort("medium", null),
      ]),
    ];
    expect(effectiveJudgeReasoningEffort(models, "sonnet", "high")).toEqual(
      high,
    );
  });

  it("falls back to the lowest advertised option when the requested one is not advertised", () => {
    const low = effort("low", null);
    const models: readonly GuiAgentModelOption[] = [
      model("sonnet", null, [
        effort("high", null),
        low,
        effort("medium", null),
      ]),
    ];
    expect(effectiveJudgeReasoningEffort(models, "sonnet", "xhigh")).toEqual(
      low,
    );
  });

  it("falls back to the lowest advertised option when requested is null", () => {
    const low = effort("low", null);
    const models: readonly GuiAgentModelOption[] = [
      model("sonnet", null, [
        effort("high", null),
        low,
        effort("medium", null),
      ]),
    ];
    expect(effectiveJudgeReasoningEffort(models, "sonnet", null)).toEqual(low);
  });

  it("resolves a row matched only through metadata.resolvedModel (an alias match) and still answers the effort", () => {
    const low = effort("low", null);
    const models: readonly GuiAgentModelOption[] = [
      model("opus[1m]", "claude-opus-5[1m]", [effort("high", null), low]),
    ];
    // "claude-opus-5[1m]" is not any row's slug - only its resolvedModel - so
    // this only resolves through resolveModelBySlug's pass 2 (alias match).
    expect(
      effectiveJudgeReasoningEffort(models, "claude-opus-5[1m]", null),
    ).toEqual(low);
  });

  it("resolves the requested effort on a row matched only through metadata.resolvedModel", () => {
    const high = effort("high", null);
    const models: readonly GuiAgentModelOption[] = [
      model("opus[1m]", "claude-opus-5[1m]", [effort("low", null), high]),
    ];
    expect(
      effectiveJudgeReasoningEffort(models, "claude-opus-5[1m]", "high"),
    ).toEqual(high);
  });

  it("returns null for an empty slug (resolveModelBySlug's own none case)", () => {
    const models: readonly GuiAgentModelOption[] = [
      model("sonnet", null, [effort("low", null)]),
    ];
    expect(effectiveJudgeReasoningEffort(models, "", null)).toBeNull();
  });
});
