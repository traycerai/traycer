import { describe, expect, it } from "vitest";
import {
  layoutFindResults,
  wordStartMatch,
} from "@/components/layout-editor/regions/region-filter-match";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

/**
 * Find a setting's own matcher (L-07): `wordStartMatch` never fires mid-word,
 * and `layoutFindResults` is the one function that turns a query into the
 * ranked list the UI draws.
 */

describe("wordStartMatch", () => {
  it("skips a mid-word occurrence and finds a later word-start one", () => {
    // "shar" sits inside "Resharing" too, but only the second occurrence -
    // the one that opens "sharing" - starts a word.
    expect(wordStartMatch("Resharing sharing", "shar")).toEqual([10, 13]);
  });

  it("returns null for a whitespace-only query", () => {
    expect(wordStartMatch("Ring only", "   ")).toBeNull();
  });
});

describe("layoutFindResults", () => {
  it("never surfaces Sharing on 'ring' - only the word-start hit", () => {
    const results = layoutFindResults("ring", DEFAULT_LAYOUT_SNAPSHOT);

    expect(results.some((result) => result.label === "Sharing")).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]?.region).toBe("contextUsage");
    expect(results[0]?.detail).toEqual({
      text: "Ring and number",
      match: [0, 3],
    });
  });

  it("returns [] for an empty or whitespace-only query", () => {
    expect(layoutFindResults("", DEFAULT_LAYOUT_SNAPSHOT)).toEqual([]);
    expect(layoutFindResults("   ", DEFAULT_LAYOUT_SNAPSHOT)).toEqual([]);
  });

  it("ranks an area match, then a name match, ahead of an option/state/keyword match", () => {
    // "usage" starts a word in the Usage and resources AREA label, in
    // Context usage's own NAME, and in Usage limits' own name - all rank
    // above anything that only matches through a detail or a keyword.
    const results = layoutFindResults("usage", DEFAULT_LAYOUT_SNAPSHOT);

    expect(results.map((result) => result.key)).toEqual([
      "area:statusBar",
      "contextUsage",
      "usageLimits",
    ]);
    expect(results[0]?.kind).toBe("area");
  });

  it("carries the matched option as the detail, ranked ahead of a keyword hit", () => {
    expect(layoutFindResults("amount", DEFAULT_LAYOUT_SNAPSHOT)).toEqual([
      expect.objectContaining({
        region: "usageLimits",
        detail: { text: "Amount", match: [0, 5] },
      }),
    ]);
    // "Cache read" is a Breakdown-rows option on Context usage (Chat), not on
    // Usage limits - a different region's detail than a query alone suggests.
    expect(layoutFindResults("cache read", DEFAULT_LAYOUT_SNAPSHOT)).toEqual([
      expect.objectContaining({
        region: "contextUsage",
        detail: { text: "Cache read", match: [0, 9] },
      }),
    ]);
    // A keyword-only hit ("quota" is Usage limits' own keyword, not part of
    // its name or any option/state word).
    expect(layoutFindResults("quota", DEFAULT_LAYOUT_SNAPSHOT)).toEqual([
      expect.objectContaining({
        region: "usageLimits",
        detail: { text: "quota", match: [0, 4] },
      }),
    ]);
  });

  it("lists an area's own row as a setting - region null, its search anchor", () => {
    const results = layoutFindResults("placement", DEFAULT_LAYOUT_SNAPSHOT);

    expect(results).toEqual([
      expect.objectContaining({
        key: "tabStripPlacement",
        kind: "setting",
        area: "topBar",
        region: null,
        anchor: "layout-tab-strip-placement",
        label: "Placement",
      }),
    ]);
  });

  it("finds Model on its Reasoning control row's own examples and label", () => {
    for (const [query, detailText] of [
      ["slider", "Slider"],
      ["list", "List"],
      ["reasoning", "Reasoning control"],
    ] as const) {
      const results = layoutFindResults(query, DEFAULT_LAYOUT_SNAPSHOT);
      const model = results.find((result) => result.region === "model");
      expect(model, query).not.toBeUndefined();
      expect(model?.detail?.text, query).toBe(detailText);
    }
  });

  it("lists a matching area as its own result, with no anchor or detail", () => {
    const results = layoutFindResults("composer", DEFAULT_LAYOUT_SNAPSHOT);

    expect(results).toEqual([
      expect.objectContaining({
        key: "area:composer",
        kind: "area",
        area: "composer",
        region: null,
        anchor: null,
        label: "Composer",
        detail: null,
      }),
    ]);
  });

  it("finds Minimap through its artifact keywords - the minimap now sits on artifacts too", () => {
    // "outline" is a Minimap-only keyword, so it surfaces as the sole result.
    expect(layoutFindResults("outline", DEFAULT_LAYOUT_SNAPSHOT)).toEqual([
      expect.objectContaining({
        region: "minimap",
        detail: { text: "outline", match: [0, 6] },
      }),
    ]);

    // "artifact" is also Reading width's own keyword (Layout > Chat), so
    // Minimap must still be among the results rather than the only one.
    const artifactResults = layoutFindResults(
      "artifact",
      DEFAULT_LAYOUT_SNAPSHOT,
    );
    expect(artifactResults.some((result) => result.region === "minimap")).toBe(
      true,
    );
  });
});
