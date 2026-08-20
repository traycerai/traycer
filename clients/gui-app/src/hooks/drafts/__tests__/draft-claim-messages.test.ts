import { describe, expect, it } from "vitest";
import { draftClaimUserMessage } from "@/hooks/drafts/use-draft-claim";

describe("draftClaimUserMessage", () => {
  it("names unsupported-version instead of a generic failure", () => {
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "unsupported-version",
      }),
    ).toBe("This draft needs a newer Traycer to open.");
  });

  it("hides plan-ineligible and old-host answers", () => {
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "plan-ineligible",
      }),
    ).toBeNull();
    expect(draftClaimUserMessage({ status: "unsupported" })).toBeNull();
  });
});
