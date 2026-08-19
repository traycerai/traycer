import { describe, expect, it } from "vitest";
import { collabTileNotice } from "../collab-tile-availability-copy";

/**
 * `unavailable` and `loading`(budget-elapsed) used to render byte-identical
 * markup - the same pulsing-bars placeholder, told apart only by a
 * `data-testid` suffix nothing visible carries. These pins are the whole
 * reason this module exists: the three outcomes must be three DISTINCT
 * strings, not one generic notice reused three ways.
 */
describe("collabTileNotice", () => {
  it("unavailable: says the room failed on its host, promises no later load", () => {
    const message = collabTileNotice("unavailable", false);
    expect(message).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("retrying: says it is reconnecting", () => {
    const message = collabTileNotice("retrying", false);
    expect(message).toBe("Reconnecting to this document…");
  });

  it("ready + budget elapsed: says it hasn't loaded yet", () => {
    const message = collabTileNotice("ready", true);
    expect(message).toBe("This document hasn't loaded yet.");
  });

  it("ready + budget NOT elapsed: renders null - still plausibly arriving, keep the placeholder", () => {
    expect(collabTileNotice("ready", false)).toBeNull();
  });

  it("unavailable wins over an elapsed budget - the room failure is the more specific truth", () => {
    expect(collabTileNotice("unavailable", true)).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("retrying wins over an elapsed budget too", () => {
    expect(collabTileNotice("retrying", true)).toBe(
      "Reconnecting to this document…",
    );
  });

  it("all three non-null outcomes are pairwise DISTINCT strings", () => {
    const unavailable = collabTileNotice("unavailable", false);
    const retrying = collabTileNotice("retrying", false);
    const elapsed = collabTileNotice("ready", true);
    expect(new Set([unavailable, retrying, elapsed]).size).toBe(3);
  });
});
