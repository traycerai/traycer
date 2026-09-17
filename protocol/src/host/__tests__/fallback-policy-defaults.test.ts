import { describe, expect, it } from "vitest";
import { createDefaultFallbackPolicy } from "@traycer/protocol/host/fallback-policy";

describe("createDefaultFallbackPolicy", () => {
  // The doc promises "fresh data on every read; no caller can mutate another
  // user's defaults". A shared array would break that silently: one caller's
  // push would appear in every later default.
  it("creates independent mutable arrays for every default policy", () => {
    const first = createDefaultFallbackPolicy();
    const second = createDefaultFallbackPolicy();
    expect(first.tierGroups).toEqual([]);
    expect(first.tierGroups).not.toBe(second.tierGroups);
    expect(first.ladder).not.toBe(second.ladder);
  });
});
