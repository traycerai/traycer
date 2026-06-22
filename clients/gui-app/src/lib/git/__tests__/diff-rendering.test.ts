import { describe, expect, it } from "vitest";
import { buildPatchCacheKey, resolveDiffThemeName } from "../diff-rendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel")).toBe(
      buildPatchCacheKey(patch, "diff-panel"),
    );
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`, "diff-panel")).toBe(
      buildPatchCacheKey(patch, "diff-panel"),
    );
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before, "diff-panel")).not.toBe(
      buildPatchCacheKey(after, "diff-panel"),
    );
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("resolveDiffThemeName", () => {
  it('returns "pierre-dark" for dark theme', () => {
    expect(resolveDiffThemeName("dark")).toBe("pierre-dark");
  });

  it('returns "pierre-light" for light theme', () => {
    expect(resolveDiffThemeName("light")).toBe("pierre-light");
  });
});
