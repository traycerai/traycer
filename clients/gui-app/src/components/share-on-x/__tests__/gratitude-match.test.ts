import { describe, expect, it } from "vitest";
import {
  matchGratitude,
  type GratitudeMatchKey,
} from "@/components/share-on-x/gratitude-match";

describe("matchGratitude", () => {
  it.each<readonly [string, GratitudeMatchKey]>([
    ["Thanks!", "thank_you"],
    ["tysm, that fixed it", "thank_you"],
    ["much appreciated", "appreciate"],
    ["Great job on the refactor.", "great_job"],
    ["well done", "great_job"],
    ["nailed it", "nailed_it"],
    ["That's perfect", "perfect"],
    ["love it", "love_it"],
    ["you're a legend", "legend"],
  ])("matches %j as %s", (text, key) => {
    expect(matchGratitude(text)).toBe(key);
  });

  it.each(["type this into the file", "happy thanksgiving plans", "empty"])(
    "ignores a phrase that is only part of a word: %j",
    (text) => {
      expect(matchGratitude(text)).toBeNull();
    },
  );

  it.each([
    "no thanks",
    "Thanks, but this is still broken",
    "thank you but that is wrong",
    "this is not perfect",
    "far from perfect",
  ])("ignores a negated thank-you: %j", (text) => {
    expect(matchGratitude(text)).toBeNull();
  });

  it("ignores a message over 200 characters", () => {
    const body = "x".repeat(200 - "thanks ".length);
    expect(matchGratitude(`thanks ${body}`)).toBe("thank_you");
    expect(matchGratitude(`thanks ${body}y`)).toBeNull();
  });

  it("ignores an empty or punctuation-only message", () => {
    expect(matchGratitude("")).toBeNull();
    expect(matchGratitude("!!!")).toBeNull();
  });
});
