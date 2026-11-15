import { describe, expect, it } from "vitest";
import { claimedComputerSentence } from "../claimed-computer-notice-model";

describe("claimedComputerSentence", () => {
  it("names the claimant and the team the computer left, as the owner ruled", () => {
    expect(claimedComputerSentence("Ada", "Build Team")).toBe(
      "Ada claimed this computer. It no longer belongs to Build Team.",
    );
  });
});
