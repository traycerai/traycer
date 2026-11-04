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
    ["thnx!!", "thank_you"],
    ["gracias", "thank_you"],
    ["shukriya bhai", "thank_you"],
    ["kudos", "great_job"],
    ["keep it up", "great_job"],
    ["bahut badhiya", "great_job"],
    ["awesome!", "amazing"],
    ["works like a charm, ty", "nailed_it"],
    ["crushed it", "nailed_it"],
    ["chef's kiss", "perfect"],
    ["you rock", "legend"],
    ["goated", "legend"],
    ["legend", "legend"],
    ["LFG", "hype"],
    ["this is fire", "hype"],
    ["W", "hype"],
    ["🙏", "emoji"],
    ["🔥🔥🔥", "emoji"],
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
    "not great",
    "still broken, thanks",
    "not exactly perfect",
    "not exactly amazing",
    "it isn't perfect",
    "that isn't awesome",
  ])("ignores a negated thank-you: %j", (text) => {
    expect(matchGratitude(text)).toBeNull();
  });

  it.each([
    "use ty to check the stubs",
    "make the pixel perfect layout",
    "I'd love it if you also added tests",
    "run ty/ruff on project",
    "fire the event",
    "add a legend",
    "use w",
    "make it nice",
    "make it perfect",
    "keep it up with the tests and the docs",
    "lets go with option b then and also add docs",
  ])("ignores an instruction-like phrase: %j", (text) => {
    expect(matchGratitude(text)).toBeNull();
  });

  it("matches the same phrases in a short message", () => {
    expect(matchGratitude("ty")).toBe("thank_you");
    expect(matchGratitude("that's perfect!")).toBe("perfect");
    expect(matchGratitude("love this")).toBe("love_it");
    // "that's" is one word, as typed.
    expect(matchGratitude("that's just so perfect")).toBe("perfect");
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
