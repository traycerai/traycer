import { describe, expect, it } from "vitest";

import {
  FUZZY_TIER_PREFIX,
  FUZZY_TIER_SUBSEQUENCE,
  FUZZY_TIER_SUBSTRING,
  fuzzyMatchNames,
} from "../fuzzy-folder-match";

describe("FUZZY_TIER_* constants", () => {
  it("orders prefix ahead of substring ahead of subsequence", () => {
    expect(FUZZY_TIER_PREFIX).toBeLessThan(FUZZY_TIER_SUBSTRING);
    expect(FUZZY_TIER_SUBSTRING).toBeLessThan(FUZZY_TIER_SUBSEQUENCE);
  });
});

describe("fuzzyMatchNames tier ordering", () => {
  it("ranks a prefix match above a substring match above a scattered subsequence match", () => {
    // Same query "cam", one hit per tier:
    //  - "campaign-credits-service" starts with "cam"            -> prefix
    //  - "traycer-campaign-credits" has "cam" inside "campaign"  -> substring
    //  - "core-account-manager" only has c, a, m in order, apart -> subsequence
    const names = [
      "core-account-manager",
      "traycer-campaign-credits",
      "campaign-credits-service",
    ];
    const result = fuzzyMatchNames(names, (name) => name, "cam");

    expect(result.map((match) => match.item)).toEqual([
      "campaign-credits-service",
      "traycer-campaign-credits",
      "core-account-manager",
    ]);
    expect(result.map((match) => match.tier)).toEqual([
      FUZZY_TIER_PREFIX,
      FUZZY_TIER_SUBSTRING,
      FUZZY_TIER_SUBSEQUENCE,
    ]);
  });

  it("ranks the tightest subsequence span ahead of a smeared one within the same tier", () => {
    // Both only match "tam" as a scattered subsequence (neither is a prefix
    // or contains "tam" consecutively):
    //  - "team-app" matches over a 4-char span: t(0) a(2) m(3)
    //  - "traycer-campaign-mobile" matches over an 11-char span: t(0) a(2) m(10)
    const names = ["traycer-campaign-mobile", "team-app"];
    const result = fuzzyMatchNames(names, (name) => name, "tam");

    expect(result.map((match) => match.item)).toEqual([
      "team-app",
      "traycer-campaign-mobile",
    ]);
    expect(result.every((match) => match.tier === FUZZY_TIER_SUBSEQUENCE)).toBe(
      true,
    );
  });

  it("breaks ties alphabetically when tier and span are equal, regardless of input order", () => {
    // Neither starts with "app"; both match it as a substring of equal
    // length, so tier and span tie and the alphabetical tiebreak decides.
    const names = ["zeta-app-core", "alpha-app-core"];
    const result = fuzzyMatchNames(names, (name) => name, "app");

    expect(result.map((match) => match.item)).toEqual([
      "alpha-app-core",
      "zeta-app-core",
    ]);
  });
});

describe("fuzzyMatchNames empty query", () => {
  it("returns every item, in input order, with empty ranges", () => {
    const names = [
      "mobile-app",
      "traycer-mp-t1-protocol",
      "traycer-campaign-credits",
    ];
    const result = fuzzyMatchNames(names, (name) => name, "");

    expect(result.map((match) => match.item)).toEqual(names);
    expect(result.every((match) => match.ranges.length === 0)).toBe(true);
  });
});

describe("fuzzyMatchNames no match", () => {
  it("drops an item entirely when the query cannot match it, even as a subsequence", () => {
    const names = ["mobile-app", "traycer-mp-t1-protocol"];
    const result = fuzzyMatchNames(names, (name) => name, "zzz");

    expect(result).toEqual([]);
  });

  it("drops only the non-matching items out of a mixed set", () => {
    const names = ["mobile-app", "traycer-campaign-credits"];
    const result = fuzzyMatchNames(names, (name) => name, "mobile");

    expect(result.map((match) => match.item)).toEqual(["mobile-app"]);
  });
});

describe("fuzzyMatchNames ranges", () => {
  it("coalesces adjacent matched characters into one range instead of one range per character", () => {
    // "mobile-app": m(0) o b i l e - a(7) p(8) p(9)
    // query "map" matches m@0 standalone, then a@7 and p@8 are adjacent and
    // must coalesce into a single {start:7, end:9} range rather than two.
    const [match] = fuzzyMatchNames(["mobile-app"], (name) => name, "map");

    expect(match).toBeDefined();
    expect(match.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 7, end: 9 },
    ]);
  });

  it("slices the name back to exactly the query's characters", () => {
    const name = "mobile-app";
    const [match] = fuzzyMatchNames([name], (candidate) => candidate, "map");

    expect(match).toBeDefined();
    const sliced = match.ranges
      .map((range) => name.slice(range.start, range.end))
      .join("");
    expect(sliced).toBe("map");
  });

  it("produces one prefix range spanning the whole query for a prefix match", () => {
    const [match] = fuzzyMatchNames(["mobile-app"], (name) => name, "mob");

    expect(match).toBeDefined();
    expect(match.ranges).toEqual([{ start: 0, end: 3 }]);
  });

  it("produces one substring range at the match's position", () => {
    const [match] = fuzzyMatchNames(
      ["traycer-mp-t1-protocol"],
      (name) => name,
      "mp",
    );

    expect(match).toBeDefined();
    expect(match.ranges).toEqual([{ start: 8, end: 10 }]);
  });
});

describe("fuzzyMatchNames case-insensitivity", () => {
  it("matches an uppercase query against a lowercase name", () => {
    const result = fuzzyMatchNames(["mobile-app"], (name) => name, "MOB");

    expect(result.map((match) => match.item)).toEqual(["mobile-app"]);
    expect(result[0].tier).toBe(FUZZY_TIER_PREFIX);
  });

  it("matches a lowercase query against an uppercase name", () => {
    const result = fuzzyMatchNames(["MOBILE-APP"], (name) => name, "mob");

    expect(result.map((match) => match.item)).toEqual(["MOBILE-APP"]);
    expect(result[0].tier).toBe(FUZZY_TIER_PREFIX);
  });
});

describe("index alignment and span minimisation", () => {
  it("marks the character the user actually matched when folding resizes", () => {
    // `\u0130`.toLowerCase() is TWO code units, so a naive fold shifts every
    // later index and the highlight lands on the wrong character - and these
    // ranges are used to slice the ORIGINAL name.
    const ranked = fuzzyMatchNames(["\u0130foo"], (name) => name, "f");
    expect(ranked).toHaveLength(1);
    const range = ranked[0].ranges[0];
    expect("\u0130foo".slice(range.start, range.end)).toBe("f");
  });

  it("takes the tightest run, not the leftmost one", () => {
    // "a---b-a-b" spans 5 from its first `a` but only 3 from its second.
    // Ranking on the leftmost start would place it behind "a--b" (span 4).
    const ranked = fuzzyMatchNames(["a---b-a-b", "a--b"], (name) => name, "ab");
    expect(ranked.map((entry) => entry.item)).toEqual(["a---b-a-b", "a--b"]);
  });
});
