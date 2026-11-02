import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/components/home/data/landing-options";
import { modelUltracodeOffered } from "@/components/home/data/model-ultracode";

function model(
  harnessId: ModelOption["harnessId"],
  metadata: Record<string, unknown>,
): ModelOption {
  return {
    harnessId,
    slug: "m",
    label: "M",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata,
  };
}

describe("modelUltracodeOffered", () => {
  it.each([true, false])("reads a stated %s from a Claude model", (offered) => {
    expect(
      modelUltracodeOffered(model("claude", { ultracodeOffered: offered })),
    ).toBe(offered);
  });

  it("is unknown when the metadata names nothing, or the model is missing or on another harness", () => {
    expect(modelUltracodeOffered(model("claude", {}))).toBeUndefined();
    expect(modelUltracodeOffered(null)).toBeUndefined();
    expect(
      modelUltracodeOffered(model("codex", { ultracodeOffered: true })),
    ).toBeUndefined();
  });
});
