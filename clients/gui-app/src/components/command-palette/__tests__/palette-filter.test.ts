import { describe, expect, it } from "vitest";
import { paletteFilter } from "@/components/command-palette/palette-cmdk-controller";

// A file/diff opener row's cmdk value + keyword, mirroring `buildCmdkValue`
// (`${id} ${label}`) and the leaf's `keywords: [file.path]`.
const value = "open:files:/ws/only:src/components/foo.tsx foo.tsx";
const keywords = ["src/components/foo.tsx"];

describe("paletteFilter", () => {
  it("scores a normal fuzzy/substring query via cmdk", () => {
    expect(paletteFilter(value, "foo", keywords)).toBeGreaterThan(0);
    expect(paletteFilter(value, "components/foo", keywords)).toBeGreaterThan(0);
  });

  it("rescues a pasted absolute path that command-score drops", () => {
    expect(
      paletteFilter(value, "/Users/me/app/src/components/foo.tsx", keywords),
    ).toBe(1);
  });

  it("rescues a pasted path even behind a scope prefix", () => {
    expect(
      paletteFilter(value, ">/Users/me/app/src/components/foo.tsx", keywords),
    ).toBe(1);
  });

  it("still rejects an unrelated pasted path", () => {
    expect(paletteFilter(value, "/Users/me/other/baz.ts", keywords)).toBe(0);
  });

  it("does not rescue non-path queries", () => {
    expect(paletteFilter(value, "zzz", keywords)).toBe(0);
  });
});

// The two layout doors are `PRIMARY_ITEM_IDS`: typing "layout" means them,
// not a task or epic whose title happens to say the word too (C15).
describe('paletteFilter - the layout doors outrank tasks for "layout"', () => {
  const layoutValue = "customize:layout Customize layout";
  const layoutSettingsValue = "customize:layout-settings Layout settings";
  // An epic row's own cmdk value + keywords shape.
  const epicValue =
    "epic:11111111-1111-1111-1111-111111111111 Visual Layout Editor Redesign";
  const epicKeywords = ["task", "epic"];

  it("scores both layout doors higher than an epic that also matches 'layout'", () => {
    const epicScore = paletteFilter(epicValue, "layout", epicKeywords);
    expect(epicScore).toBeGreaterThan(0);

    expect(paletteFilter(layoutValue, "layout", undefined)).toBeGreaterThan(
      epicScore,
    );
    expect(
      paletteFilter(layoutSettingsValue, "layout", undefined),
    ).toBeGreaterThan(epicScore);
  });

  it("still scores 0 for a query that matches neither", () => {
    // "999" rather than "zzz": both layout doors have a single 'z' in
    // "Customize", which command-score's fuzzy match still gives a sliver of
    // credit to.
    expect(paletteFilter(layoutValue, "999", undefined)).toBe(0);
    expect(paletteFilter(layoutSettingsValue, "999", undefined)).toBe(0);
  });
});
