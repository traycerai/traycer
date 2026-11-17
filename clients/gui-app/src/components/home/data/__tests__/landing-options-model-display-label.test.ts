import { describe, expect, it } from "vitest";
import {
  modelDisplayLabel,
  type ModelOption,
} from "@/components/home/data/landing-options";

function model(harnessId: ModelOption["harnessId"]): ModelOption {
  return {
    harnessId,
    slug: "m",
    label: "DeepSeek V4 Pro",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: { openCodeProviderLabel: "DeepSeek" },
  };
}

describe("modelDisplayLabel", () => {
  it("shows a Traycer inference name in full and still trims other harnesses", () => {
    expect(modelDisplayLabel(model("traycer"))).toBe("DeepSeek V4 Pro");
    expect(modelDisplayLabel(model("opencode"))).toBe("V4 Pro");
  });
});
