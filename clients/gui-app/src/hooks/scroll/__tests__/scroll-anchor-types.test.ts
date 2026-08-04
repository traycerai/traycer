import { describe, expect, it } from "vitest";
import { isTileScrollAnchor } from "@/hooks/scroll/scroll-anchor-types";

describe("isTileScrollAnchor", () => {
  it("accepts a complete Virtuoso state snapshot", () => {
    expect(
      isTileScrollAnchor({
        kind: "bundle-diff",
        virtuosoState: { scrollTop: 42, ranges: [] },
      }),
    ).toBe(true);
  });

  it("rejects incomplete or malformed Virtuoso state snapshots", () => {
    expect(
      isTileScrollAnchor({
        kind: "bundle-diff",
        virtuosoState: { scrollTop: 42 },
      }),
    ).toBe(false);
    expect(
      isTileScrollAnchor({
        kind: "bundle-diff",
        virtuosoState: { scrollTop: 42, ranges: {} },
      }),
    ).toBe(false);
    expect(
      isTileScrollAnchor({
        kind: "bundle-diff",
        virtuosoState: { scrollTop: Number.NaN, ranges: [] },
      }),
    ).toBe(false);
  });
});
