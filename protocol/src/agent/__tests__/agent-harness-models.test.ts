import { describe, expect, it } from "vitest";
import { formatListHarnessModelsResponse } from "../agent-harness-models";

describe("harness model catalog formatting", () => {
  it("shows service tier ids per model and keeps the fast-mode indicator", () => {
    const formatted = formatListHarnessModelsResponse({
      harnessId: "codex",
      models: [
        {
          id: "gpt-6.1-sol",
          reasoningEfforts: ["medium", "high"],
          fastModeAvailable: true,
          serviceTiers: ["priority", "ultrafast"],
        },
      ],
    });

    expect(formatted).toContain("[serviceTier: ids] [fastMode]");
    expect(formatted).toContain(
      "gpt-6.1-sol [reasoningEffort: medium|high] [serviceTier: priority|ultrafast] [fastMode]",
    );
    expect(formatted).toContain(
      "An explicit serviceTier takes precedence over fastMode.",
    );
  });
});
