import { describe, expect, it } from "vitest";
import {
  isPathLikeQuery,
  matchesPathQuery,
  normalizePathQuery,
} from "@/lib/commands/path-query";

describe("normalizePathQuery", () => {
  it("trims, lowercases, and POSIX-normalizes separators", () => {
    expect(normalizePathQuery("  Src\\Components\\Foo.TSX  ")).toBe(
      "src/components/foo.tsx",
    );
  });
});

describe("isPathLikeQuery", () => {
  it("is true once a separator is present", () => {
    expect(isPathLikeQuery("src/foo")).toBe(true);
    expect(isPathLikeQuery("src\\foo")).toBe(true);
  });
  it("is false for a bare token", () => {
    expect(isPathLikeQuery("foo.tsx")).toBe(false);
  });
});

describe("matchesPathQuery", () => {
  const path = "src/components/foo.tsx";

  it("matches an empty query (shows everything)", () => {
    expect(matchesPathQuery("", path)).toBe(true);
    expect(matchesPathQuery("   ", path)).toBe(true);
  });

  it("matches a substring: basename, fragment, or exact relative path", () => {
    expect(matchesPathQuery("foo", path)).toBe(true);
    expect(matchesPathQuery("components/foo", path)).toBe(true);
    expect(matchesPathQuery("src/components/foo.tsx", path)).toBe(true);
  });

  it("matches a pasted ABSOLUTE path (over-qualified)", () => {
    expect(
      matchesPathQuery("/Users/me/work/app/src/components/foo.tsx", path),
    ).toBe(true);
  });

  it("matches a pasted repo-relative path (over-qualified)", () => {
    expect(matchesPathQuery("packages/app/src/components/foo.tsx", path)).toBe(
      true,
    );
  });

  it("matches a pasted Windows-style absolute path", () => {
    expect(
      matchesPathQuery("C:\\work\\app\\src\\components\\foo.tsx", path),
    ).toBe(true);
  });

  it("keeps the suffix test on segment boundaries", () => {
    // candidate `bar/foo.tsx` must NOT match a paste ending in `…/foobar/foo.tsx`
    expect(matchesPathQuery("x/foobar/foo.tsx", "bar/foo.tsx")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(matchesPathQuery("/Users/me/other/baz.ts", path)).toBe(false);
  });
});
