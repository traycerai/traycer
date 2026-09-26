import { describe, expect, it } from "vitest";
import { collabTileNotice } from "../collab-tile-availability-copy";
import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";

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
 * `retrying` is TWO outcomes, not one, and `bodyShownOnce` is what tells them
 * apart. On the wire `retrying` means an open attempt is in flight - the
 * first attempt included - so it is the first answer most tiles get on a cold
 * open, and a body that has never shown once is waiting on that first
 * attempt: the skeleton, not a sentence about reconnecting to a document that
 * was never connected. Only a body this tile has already shown (`retrying`
 * reached AFTER `bodyShownOnce` went true) is a genuine lost connection, and
 * that one says "Reconnecting to this document…" - and says it even over an
 * elapsed budget, because the more specific fact (a real disconnect) beats
 * the generic one (a long wait).
 */
describe("collabTileNotice", () => {
  it("unanswered + unavailable + budget NOT elapsed: renders null - this is the lever. A tile that has not been asked yet must not speak a host-refusal verdict nobody gave", () => {
    expect(collabTileNotice("unavailable", false, false, false)).toBeNull();
  });

  it("unanswered + unavailable + budget elapsed: says it hasn't loaded yet, NOT the host-refusal sentence - the un-answered window still terminates instead of pulsing forever", () => {
    const message = collabTileNotice("unavailable", true, false, false);
    expect(message).toBe("This document hasn't loaded yet.");
  });

  it("answered + unavailable + never shown: says the room failed on its host, promises no later load", () => {
    const message = collabTileNotice("unavailable", false, true, false);
    expect(message).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("answered + unavailable + shown once: the same refusal copy - a room that already showed a body can still be refused on a later attempt", () => {
    const message = collabTileNotice("unavailable", false, true, true);
    expect(message).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("answered + unavailable wins over an elapsed budget, never shown once - the room failure is the more specific truth", () => {
    expect(collabTileNotice("unavailable", true, true, false)).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("answered + unavailable wins over an elapsed budget, shown once too", () => {
    expect(collabTileNotice("unavailable", true, true, true)).toBe(
      "This document isn't available right now. It couldn't be opened on its host.",
    );
  });

  it("answered + retrying + never shown + budget NOT elapsed: renders null - a FIRST open reported retrying keeps the skeleton, since no connection ever preceded it", () => {
    expect(collabTileNotice("retrying", false, true, false)).toBeNull();
  });

  it("answered + retrying + never shown + budget elapsed: says it hasn't loaded yet - a first attempt still in flight is bounded by the same budget as every other wait", () => {
    expect(collabTileNotice("retrying", true, true, false)).toBe(
      "This document hasn't loaded yet.",
    );
  });

  it("answered + retrying + shown once: says it is reconnecting - only a body this tile has already shown can be RE-connecting", () => {
    expect(collabTileNotice("retrying", false, true, true)).toBe(
      "Reconnecting to this document…",
    );
  });

  it("answered + retrying + shown once wins over an elapsed budget - the reconnect is the more specific, more recent truth", () => {
    expect(collabTileNotice("retrying", true, true, true)).toBe(
      "Reconnecting to this document…",
    );
  });

  it("unanswered + retrying + never shown + budget NOT elapsed: renders null", () => {
    expect(collabTileNotice("retrying", false, false, false)).toBeNull();
  });

  it("unanswered + retrying + shown once + budget NOT elapsed: renders null too - an un-answered tile is loading however the shown-once latch reads", () => {
    expect(collabTileNotice("retrying", false, false, true)).toBeNull();
  });

  it("ready + budget elapsed: says it hasn't loaded yet", () => {
    const message = collabTileNotice("ready", true, true, false);
    expect(message).toBe("This document hasn't loaded yet.");
  });

  it("ready + budget NOT elapsed: renders null - still plausibly arriving, keep the placeholder", () => {
    expect(collabTileNotice("ready", false, true, false)).toBeNull();
  });

  it("the three non-null outcomes are pairwise DISTINCT strings", () => {
    const refusal = collabTileNotice("unavailable", false, true, false);
    const elapsed = collabTileNotice("ready", true, true, false);
    const reconnecting = collabTileNotice("retrying", false, true, true);
    expect(new Set([refusal, elapsed, reconnecting]).size).toBe(3);
  });

  it("exhaustive sweep: 'Reconnecting' appears ONLY when answered && retrying && bodyShownOnce", () => {
    const availabilities: readonly EpicArtifactRoomAvailability[] = [
      "ready",
      "unavailable",
      "retrying",
    ];
    for (const availability of availabilities) {
      for (const budgetElapsed of [false, true]) {
        for (const subscribeAnswered of [false, true]) {
          for (const bodyShownOnce of [false, true]) {
            const notice = collabTileNotice(
              availability,
              budgetElapsed,
              subscribeAnswered,
              bodyShownOnce,
            );
            const isReconnecting = notice === "Reconnecting to this document…";
            const expectedReconnecting =
              subscribeAnswered && availability === "retrying" && bodyShownOnce;
            expect(isReconnecting).toBe(expectedReconnecting);
          }
        }
      }
    }
  });
});
