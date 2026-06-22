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
