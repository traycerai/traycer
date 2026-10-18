import { describe, expect, it } from "vitest";
import {
  agentFailurePresentation,
  presentationForUntypedCode,
} from "@/components/chat/segments/agent-failure-presentation";

describe("presentationForUntypedCode", () => {
  it("presents CLAUDE_RUNTIME_DISPOSED as an interruption headlined Session ended", () => {
    expect(presentationForUntypedCode("CLAUDE_RUNTIME_DISPOSED")).toEqual({
      presentation: "interrupted",
      headline: "Session ended",
    });
  });

  it("presents an unanswered predecessor fence as an interruption", () => {
    expect(
      presentationForUntypedCode("CLAUDE_PREVIOUS_SESSION_STOPPING"),
    ).toEqual({
      presentation: "interrupted",
      headline: "Previous session still stopping",
    });
  });

  it("returns null with no code, which keeps the red row", () => {
    expect(presentationForUntypedCode(null)).toBeNull();
  });

  it("returns null for a code the client cannot vouch for", () => {
    expect(presentationForUntypedCode("SOME_OTHER_HOST_CODE")).toBeNull();
    // Matched exactly: neither a different case nor a substring is the code.
    expect(presentationForUntypedCode("claude_runtime_disposed")).toBeNull();
    expect(
      presentationForUntypedCode("CLAUDE_RUNTIME_DISPOSED_LATER"),
    ).toBeNull();
  });

  it("leaves a row with no typed reason red on the typed path", () => {
    // The untyped code table is the ONLY way an untyped row turns calm.
    expect(agentFailurePresentation(null)).toBe("error");
  });
});
