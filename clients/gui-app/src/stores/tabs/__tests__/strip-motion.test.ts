import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabRefKey } from "@/stores/tabs/layout";
import {
  markClosingTabs,
  markOpenedTabs,
  markReopenedTabs,
  peekStripEntrance,
  resetStripMotionForTesting,
  settleStripEntrance,
  stripGroupMarkKey,
  subscribeClosingTabs,
  takeReopenGlow,
} from "@/stores/tabs/strip-motion";
import type { TabRef } from "@/stores/tabs/types";

/** Marks expire on the module's own `performance.now()` clock, so drive that. */
let nowMs = 0;

function epicRef(id: string): TabRef {
  return { kind: "epic", id };
}

function delayFor(ref: TabRef): number | null {
  return peekStripEntrance([tabRefKey(ref)])?.delayMs ?? null;
}

beforeEach(() => {
  resetStripMotionForTesting();
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markOpenedTabs", () => {
  it("marks every opened tab to enter at once and leaves other tabs unmarked", () => {
    const opened = [epicRef("a"), epicRef("b")];
    markOpenedTabs(opened);

    expect(delayFor(opened[0])).toBe(0);
    expect(delayFor(opened[1])).toBe(0);
    expect(delayFor(epicRef("other"))).toBeNull();
  });

  it("records no reopen glow", () => {
    const only = epicRef("a");
    markOpenedTabs([only]);

    expect(takeReopenGlow([tabRefKey(only)])).toBe(false);
  });
});

describe("markReopenedTabs", () => {
  it("staggers reopened tabs in strip order, 30ms apart", () => {
    const refs = [epicRef("a"), epicRef("b"), epicRef("c")];
    markReopenedTabs({ refs, returningGroupIds: [] });

    expect(refs.map(delayFor)).toEqual([0, 30, 60]);
  });

  it("caps the stagger at 240ms however many tabs come back", () => {
    const refs = Array.from({ length: 12 }, (_, index) =>
      epicRef(`tab-${index}`),
    );
    markReopenedTabs({ refs, returningGroupIds: [] });

    expect(refs.map(delayFor)).toEqual([
      0, 30, 60, 90, 120, 150, 180, 210, 240, 240, 240, 240,
    ]);
  });

  it("opens a returning group's chip first and holds its tabs back by 60ms", () => {
    const refs = [epicRef("a"), epicRef("b")];
    markReopenedTabs({ refs, returningGroupIds: ["group-1", "group-2"] });

    expect(peekStripEntrance([stripGroupMarkKey("group-1")])).toEqual({
      delayMs: 0,
    });
    expect(peekStripEntrance([stripGroupMarkKey("group-2")])).toEqual({
      delayMs: 0,
    });
    expect(refs.map(delayFor)).toEqual([60, 90]);
  });

  it("gives a single reopened tab the join glow", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [] });

    expect(takeReopenGlow([tabRefKey(only)])).toBe(true);
  });

  it("gives no glow when several tabs come back together", () => {
    const refs = [epicRef("a"), epicRef("b")];
    markReopenedTabs({ refs, returningGroupIds: [] });

    expect(takeReopenGlow(refs.map(tabRefKey))).toBe(false);
  });
});

describe("peekStripEntrance", () => {
  it("returns the smallest delay among the keys a split carries", () => {
    const refs = [epicRef("a"), epicRef("b"), epicRef("c")];
    markReopenedTabs({ refs, returningGroupIds: [] });

    expect(peekStripEntrance([tabRefKey(refs[2]), tabRefKey(refs[1])])).toEqual(
      { delayMs: 30 },
    );
  });

  it("returns null when none of the keys is marked", () => {
    markOpenedTabs([epicRef("a")]);

    expect(peekStripEntrance([tabRefKey(epicRef("b"))])).toBeNull();
    expect(peekStripEntrance([])).toBeNull();
  });

  it("does not consume the mark, so a StrictMode rerun still finds it", () => {
    const only = epicRef("a");
    markOpenedTabs([only]);

    expect(delayFor(only)).toBe(0);
    expect(delayFor(only)).toBe(0);
  });

  it("ignores a mark once it is a second old", () => {
    const only = epicRef("a");
    markOpenedTabs([only]);

    nowMs = 999;
    expect(delayFor(only)).toBe(0);
    nowMs = 1000;
    expect(delayFor(only)).toBeNull();
  });

  it("skips a stale mark and answers with a fresh one for another key", () => {
    const stale = epicRef("stale");
    const fresh = epicRef("fresh");
    markOpenedTabs([stale]);
    nowMs = 900;
    // `fresh` is second in strip order, so it carries a 30ms delay.
    markReopenedTabs({
      refs: [epicRef("first"), fresh],
      returningGroupIds: [],
    });

    nowMs = 1000;
    expect(peekStripEntrance([tabRefKey(stale), tabRefKey(fresh)])).toEqual({
      delayMs: 30,
    });
  });
});

describe("settleStripEntrance", () => {
  it("clears the settled keys and keeps the rest", () => {
    const settled = epicRef("settled");
    const kept = epicRef("kept");
    markOpenedTabs([settled, kept]);

    settleStripEntrance([tabRefKey(settled)]);

    expect(delayFor(settled)).toBeNull();
    expect(delayFor(kept)).toBe(0);
  });

  it("leaves a single reopen's glow for the selection to take", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [] });

    settleStripEntrance([tabRefKey(only)]);

    expect(takeReopenGlow([tabRefKey(only)])).toBe(true);
  });
});

describe("takeReopenGlow", () => {
  it("is owed once and consumed by the first take", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [] });

    expect(takeReopenGlow([tabRefKey(only)])).toBe(true);
    expect(takeReopenGlow([tabRefKey(only)])).toBe(false);
  });

  it("is owed when any one of the keys carries the glow", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [] });

    expect(takeReopenGlow([tabRefKey(epicRef("b")), tabRefKey(only)])).toBe(
      true,
    );
  });

  it("is not owed once the reopen is a second old", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [] });

    nowMs = 1000;
    expect(takeReopenGlow([tabRefKey(only)])).toBe(false);
  });
});

describe("closing listeners", () => {
  it("notifies every subscriber each time a close is about to land", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeClosingTabs(first);
    subscribeClosingTabs(second);

    markClosingTabs();
    markClosingTabs();

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("stops notifying a subscriber once it unsubscribes", () => {
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = subscribeClosingTabs(leaving);
    subscribeClosingTabs(staying);

    unsubscribe();
    markClosingTabs();

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });
});
