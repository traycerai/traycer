import { describe, expect, it } from "vitest";
import { collabTileNotice } from "../collab-tile-availability-copy";

/**
 * `unavailable` and `loading`(budget-elapsed) used to render byte-identical
 * markup - the same pulsing-bars placeholder, told apart only by a
 * `data-testid` suffix nothing visible carries. These pins are the whole
 * reason this module exists: the two spoken outcomes must be two DISTINCT
 * strings, not one generic notice reused two ways.
 *
 * A third outcome hides inside `"unavailable"` itself: every layer below
 * collapses an artifact the body plane has not answered yet into the same
 * `"unavailable"` union member a genuine host refusal produces, so
 * `subscribeAnswered` is what tells the two apart here.
 *
 * `retrying` is NOT a spoken outcome. On the wire it means an open attempt is
 * in flight - the first attempt included - so it is the first answer most
 * tiles get on a cold open, and a sentence there replaced the skeleton one
 * frame after it appeared with a "Reconnecting…" no connection had preceded.
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

  it("answered + retrying + budget NOT elapsed: renders null - an open attempt in flight is the placeholder, not a reconnect sentence", () => {
    expect(collabTileNotice("retrying", false, true)).toBeNull();
  });

  it("unanswered + retrying + budget NOT elapsed: renders null too", () => {
    expect(collabTileNotice("retrying", false, false)).toBeNull();
  });

  it("answered + retrying + budget elapsed: says it hasn't loaded yet - the attempt in flight is bounded by the same budget as every other wait", () => {
    expect(collabTileNotice("retrying", true, true)).toBe(
      "This document hasn't loaded yet.",
    );
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

  it("the two non-null outcomes are DISTINCT strings, and no outcome says 'Reconnecting'", () => {
    const unavailable = collabTileNotice("unavailable", false, true);
    const elapsed = collabTileNotice("ready", true, true);
    expect(new Set([unavailable, elapsed]).size).toBe(2);
    const availabilities = ["ready", "unavailable", "retrying"] as const;
    for (const availability of availabilities) {
      for (const budgetElapsed of [false, true]) {
        for (const answered of [false, true]) {
          const notice = collabTileNotice(
            availability,
            budgetElapsed,
            answered,
          );
          expect(notice ?? "").not.toMatch(/reconnect/i);
        }
      }
    }
  });
});
