import { describe, expect, it } from "vitest";
import { collabTileNotice } from "../collab-tile-availability-copy";

/**
 * `unavailable` and `loading`(budget-elapsed) used to render byte-identical
 * markup - the same pulsing-bars placeholder, told apart only by a
 * `data-testid` suffix nothing visible carries. These pins are the whole
 * reason this module exists: the three outcomes must be three DISTINCT
 * strings, not one generic notice reused three ways.
 *
 * A fourth outcome hides inside `"unavailable"` itself: every layer below
 * collapses an artifact the body plane has not answered yet into the same
 * `"unavailable"` union member a genuine host refusal produces, so
 * `subscribeAnswered` is what tells the two apart here.
 */
describe("collabTileNotice", () => {
  it("unanswered + unavailable + budget NOT elapsed: renders null - this is the lever. A tile that has not been asked yet must not speak a host-refusal verdict nobody gave", () => {
    expect(collabTileNotice("unavailable", false, false)).toBeNull();
  });

  it("unanswered + unavailable + budget elapsed: says it hasn't loaded yet, NOT the host-refusal sentence - the un-answered window still terminates instead of pulsing forever", () => {
    const message = collabTileNotice("unavailable", true, false);
    expect(message).toBe("This document hasn't loaded yet.");
  });

  it("answered + unavailable: says the room failed on its host, promises no later load", () => {
    const message = collabTileNotice("unavailable", false, true);
    expect(message).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("answered + retrying: says it is reconnecting", () => {
    const message = collabTileNotice("retrying", false, true);
    expect(message).toBe("Reconnecting to this document…");
  });

  it("ready + budget elapsed: says it hasn't loaded yet", () => {
    const message = collabTileNotice("ready", true, true);
    expect(message).toBe("This document hasn't loaded yet.");
  });

  it("ready + budget NOT elapsed: renders null - still plausibly arriving, keep the placeholder", () => {
    expect(collabTileNotice("ready", false, true)).toBeNull();
  });

  it("answered + unavailable wins over an elapsed budget - the room failure is the more specific truth", () => {
    expect(collabTileNotice("unavailable", true, true)).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("answered + retrying wins over an elapsed budget too", () => {
    expect(collabTileNotice("retrying", true, true)).toBe(
      "Reconnecting to this document…",
    );
  });

  it("all three non-null outcomes are pairwise DISTINCT strings", () => {
    const unavailable = collabTileNotice("unavailable", false, true);
    const retrying = collabTileNotice("retrying", false, true);
    const elapsed = collabTileNotice("ready", true, true);
    expect(new Set([unavailable, retrying, elapsed]).size).toBe(3);
  });
});
