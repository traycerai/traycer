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

  it("answers every non-takeover outcome, so the banner is never mute", () => {
    // The user pressed "Edit here" and the replica stayed read-only. A null
    // here reads as a dead button, which is what these two used to be.
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "plan-ineligible",
      }),
    ).toBe("Taking over a draft from another device needs a paid plan.");
    expect(draftClaimUserMessage({ status: "unsupported" })).toBe(
      "This host is too old to take over a draft. Update it and try again.",
    );
    expect(draftClaimUserMessage({ status: "failed" })).toBe(
      "Could not take over this draft. Try again.",
    );
  });
});
