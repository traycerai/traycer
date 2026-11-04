import { describe, expect, it } from "vitest";

import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";

const draft = {
  category: "tool_problem",
  toolName: "traycer_run_shell",
  goal: "Restart a shell with a new working directory.",
  observed: "The process kept the old directory.",
  suggestion: null,
  suggestDiagnostics: true,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

const block = {
  blockId: "block-1",
  timestamp: 1,
  type: "tool_call",
  status: "completed",
  toolName: "traycer_draft_feedback",
  error: null,
};

describe("tool_call.feedbackDraft", () => {
  it("parses a block persisted before the stamp as null", () => {
    const parsed = contentBlockSchema.parse(block);
    expect(parsed.type === "tool_call" && parsed.feedbackDraft).toBeNull();
  });

  it("keeps a category this reader has not heard of", () => {
    const parsed = contentBlockSchema.parse({
      ...block,
      feedbackDraft: { ...draft, category: "future_kind" },
    });
    expect(
      parsed.type === "tool_call" && parsed.feedbackDraft?.category,
    ).toBe("future_kind");
  });

  it("reads a state this reader has not heard of as unknown, not as a failed block", () => {
    const parsed = contentBlockSchema.parse({
      ...block,
      feedbackDraft: { ...draft, state: "retracted" },
    });
    expect(parsed.type === "tool_call" && parsed.feedbackDraft?.state).toBe(
      "unknown",
    );
  });
});
