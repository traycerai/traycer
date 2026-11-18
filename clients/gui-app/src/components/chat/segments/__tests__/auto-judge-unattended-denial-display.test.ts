import { describe, expect, it } from "vitest";
import { autoJudgeUnattendedDenialText } from "@/components/chat/segments/auto-judge-unattended-denial-display";

const HEAD =
  "Refused without asking. This chat was running for another agent, so there was nobody to ask.";

describe("autoJudgeUnattendedDenialText", () => {
  it("is just the head sentence when neither rule nor reason is present", () => {
    expect(autoJudgeUnattendedDenialText({ rule: null, reason: null })).toBe(
      HEAD,
    );
  });

  it("appends only the rule when reason is null", () => {
    expect(
      autoJudgeUnattendedDenialText({ rule: "Force push", reason: null }),
    ).toBe(`${HEAD} Force push`);
  });

  it("appends only the reason when rule is null", () => {
    expect(
      autoJudgeUnattendedDenialText({
        rule: null,
        reason: "This rewrites remote history.",
      }),
    ).toBe(`${HEAD} This rewrites remote history.`);
  });

  it("appends both with an em dash when present", () => {
    expect(
      autoJudgeUnattendedDenialText({
        rule: "Force push",
        reason: "This rewrites remote history.",
      }),
    ).toBe(`${HEAD} Force push — This rewrites remote history.`);
  });
});
