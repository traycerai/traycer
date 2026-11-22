import { describe, expect, it } from "vitest";
import { formatListHarnessModelsResponse } from "../agent-harness-models";

describe("harness model catalog formatting", () => {
  it("shows service tier ids per model and keeps the fast-mode indicator", () => {
    const formatted = formatListHarnessModelsResponse({
      harnessId: "codex",
      models: [
        {
          id: "gpt-6.1-sol",
          resolvedModel: null,
          reasoningEfforts: ["medium", "high"],
          fastModeAvailable: true,
          serviceTiers: ["priority", "ultrafast"],
        },
      ],
    });

    expect(formatted).toContain("[serviceTier: ids] [fastMode]");
    expect(formatted).not.toContain("[resolvesTo: gpt");
    expect(formatted).toContain(
      "gpt-6.1-sol [reasoningEffort: medium|high] [serviceTier: priority|ultrafast] [fastMode]",
    );
    expect(formatted).toContain(
      "An explicit serviceTier takes precedence over fastMode.",
    );
  });

  it("shows resolvesTo only for a differing target, before the other annotations", () => {
    const base = {
      reasoningEfforts: ["high"],
      fastModeAvailable: true,
      serviceTiers: ["priority"],
    };
    const formatted = formatListHarnessModelsResponse({
      harnessId: "claude",
      models: [
        { ...base, id: "fable", resolvedModel: "claude-fable-5-2" },
        { ...base, id: "claude-fable-5-1", resolvedModel: "claude-fable-5-1" },
        { ...base, id: "plain", resolvedModel: null },
        { ...base, id: "opus", resolvedModel: "claude-opus-5[1m]" },
      ],
    });

    expect(formatted).toContain(
      "\nfable [resolvesTo: claude-fable-5-2] [reasoningEffort: high] [serviceTier: priority] [fastMode]",
    );
    expect(formatted).toContain(
      "\nclaude-fable-5-1 [reasoningEffort: high] [serviceTier: priority] [fastMode]",
    );
    expect(formatted).toContain("\nplain [reasoningEffort: high]");
    expect(formatted).toContain("\nopus [resolvesTo: claude-opus-5[1m]] ");
    expect(formatted).toContain("Pass model-name as the model.");
  });
});
