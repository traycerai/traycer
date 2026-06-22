import { describe, expect, it } from "vitest";
import {
  interviewBlockId,
  isClaudeInterviewToolName,
  isKnownInterviewDisplayToolName,
  isKnownInterviewToolName,
  isOpenCodeInterviewToolName,
  toolUseIdFromInterviewBlockId,
} from "../interview-tools";

describe("interview tool helpers", () => {
  it("derives and parses interview block ids", () => {
    expect(interviewBlockId("tool-1")).toBe("tool-1:interview");
    expect(toolUseIdFromInterviewBlockId("tool-1:interview")).toBe("tool-1");
    expect(toolUseIdFromInterviewBlockId(":interview")).toBeNull();
    expect(toolUseIdFromInterviewBlockId("tool-1")).toBeNull();
  });

  it("recognizes provider-specific interview tool names", () => {
    expect(isClaudeInterviewToolName("AskUserQuestion")).toBe(true);
    expect(isClaudeInterviewToolName("RequestUserInput")).toBe(true);
    expect(isClaudeInterviewToolName("question")).toBe(false);

    expect(isOpenCodeInterviewToolName("question")).toBe(true);
    expect(isOpenCodeInterviewToolName("Question")).toBe(false);
    expect(isOpenCodeInterviewToolName("AskUserQuestion")).toBe(false);

    expect(isKnownInterviewToolName("request_user_input")).toBe(true);
    expect(isKnownInterviewToolName("Question")).toBe(false);
    expect(isKnownInterviewDisplayToolName("Question")).toBe(true);
    expect(isKnownInterviewToolName("Read")).toBe(false);
  });
});
