import { describe, expect, it } from "vitest";
import {
  SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  singleDigitLeaderDigitFor,
} from "@/providers/keybinding-context";

describe("singleDigitLeaderDigitFor", () => {
  it("renders indexes 0-8 as the digits 1-9", () => {
    for (
      let index = 0;
      index < SINGLE_DIGIT_LEADER_INDEX_LIMIT - 1;
      index += 1
    ) {
      expect(singleDigitLeaderDigitFor(index)).toBe(String(index + 1));
    }
  });

  it("renders index 9 (the 10th and last single-digit slot) as 0, matching the digitToIndex dispatch mapping", () => {
    expect(singleDigitLeaderDigitFor(SINGLE_DIGIT_LEADER_INDEX_LIMIT - 1)).toBe(
      "0",
    );
  });
});
