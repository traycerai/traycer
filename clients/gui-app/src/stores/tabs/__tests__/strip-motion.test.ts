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
    markReopenedTabs({ refs, returningGroupIds: [], glowRef: null });

    expect(refs.map(delayFor)).toEqual([0, 30, 60]);
  });

  it("caps the stagger at 240ms however many tabs come back", () => {
    const refs = Array.from({ length: 12 }, (_, index) =>
      epicRef(`tab-${index}`),
    );
    markReopenedTabs({ refs, returningGroupIds: [], glowRef: null });

    expect(refs.map(delayFor)).toEqual([
      0, 30, 60, 90, 120, 150, 180, 210, 240, 240, 240, 240,
    ]);
  });

  it("opens a returning group's chip first and holds its tabs back by 60ms", () => {
    const refs = [epicRef("a"), epicRef("b")];
    markReopenedTabs({
      refs,
      returningGroupIds: ["group-1", "group-2"],
      glowRef: null,
    });

    expect(peekStripEntrance([stripGroupMarkKey("group-1")])).toEqual({
      delayMs: 0,
    });
    expect(peekStripEntrance([stripGroupMarkKey("group-2")])).toEqual({
      delayMs: 0,
    });
    expect(refs.map(delayFor)).toEqual([60, 90]);
  });

  it("gives the join glow to the ref it is told to", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [], glowRef: only });

    expect(takeReopenGlow([tabRefKey(only)])).toBe(true);
  });

  it("glows only the named ref, not the others opened with it", () => {
    const refs = [epicRef("a"), epicRef("b")];
    markReopenedTabs({ refs, returningGroupIds: [], glowRef: refs[1] });

    expect(takeReopenGlow([tabRefKey(refs[0])])).toBe(false);
    expect(takeReopenGlow([tabRefKey(refs[1])])).toBe(true);
  });

  it("gives no glow when several tabs come back together", () => {
    const refs = [epicRef("a"), epicRef("b")];
    markReopenedTabs({ refs, returningGroupIds: [], glowRef: null });

    expect(takeReopenGlow(refs.map(tabRefKey))).toBe(false);
  });

  it("does not infer a glow from a lone ref", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [], glowRef: null });

    expect(takeReopenGlow([tabRefKey(only)])).toBe(false);
  });

  it("glows a ref that opens no slot of its own", () => {
    const rejoined = epicRef("a");
    markReopenedTabs({ refs: [], returningGroupIds: [], glowRef: rejoined });

    expect(delayFor(rejoined)).toBeNull();
    expect(takeReopenGlow([tabRefKey(rejoined)])).toBe(true);
  });
});

describe("peekStripEntrance", () => {
  it("returns the smallest delay among the keys a split carries", () => {
    const refs = [epicRef("a"), epicRef("b"), epicRef("c")];
    markReopenedTabs({ refs, returningGroupIds: [], glowRef: null });

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
      glowRef: null,
    });

    nowMs = 1000;
    expect(peekStripEntrance([tabRefKey(stale), tabRefKey(fresh)])).toEqual({
      delayMs: 30,
    });
  });
});

describe("sweeping stale marks", () => {
  it("drops an expired entrance when a later open marks a tab", () => {
    const stale = epicRef("stale");
    markOpenedTabs([stale]);

    nowMs = 1001;
    markOpenedTabs([epicRef("fresh")]);

    // Back inside the stale mark's window, so only the sweep can have removed it.
    nowMs = 0;
    expect(delayFor(stale)).toBeNull();
  });

  it("drops an expired entrance when a later reopen marks tabs", () => {
    const stale = epicRef("stale");
    markOpenedTabs([stale]);

    nowMs = 1001;
    markReopenedTabs({
      refs: [epicRef("fresh")],
      returningGroupIds: [],
      glowRef: null,
    });

    nowMs = 0;
    expect(delayFor(stale)).toBeNull();
  });

  it("drops an expired reopen glow when a later gesture marks tabs", () => {
    const stale = epicRef("stale");
    markReopenedTabs({ refs: [stale], returningGroupIds: [], glowRef: stale });

    nowMs = 1001;
    markOpenedTabs([epicRef("fresh")]);

    nowMs = 0;
    expect(takeReopenGlow([tabRefKey(stale)])).toBe(false);
  });

  it("keeps a mark that has not expired when a later gesture marks tabs", () => {
    const recent = epicRef("recent");
    markOpenedTabs([recent]);

    nowMs = 999;
    markOpenedTabs([epicRef("fresh")]);

    expect(delayFor(recent)).toBe(0);
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
    markReopenedTabs({ refs: [only], returningGroupIds: [], glowRef: only });

    settleStripEntrance([tabRefKey(only)]);

    expect(takeReopenGlow([tabRefKey(only)])).toBe(true);
  });
});

describe("takeReopenGlow", () => {
  it("is owed once and consumed by the first take", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [], glowRef: only });

    expect(takeReopenGlow([tabRefKey(only)])).toBe(true);
    expect(takeReopenGlow([tabRefKey(only)])).toBe(false);
  });

  it("is owed when any one of the keys carries the glow", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [], glowRef: only });

    expect(takeReopenGlow([tabRefKey(epicRef("b")), tabRefKey(only)])).toBe(
      true,
    );
  });

  it("is not owed once the reopen is a second old", () => {
    const only = epicRef("a");
    markReopenedTabs({ refs: [only], returningGroupIds: [], glowRef: only });

    nowMs = 1000;
    expect(takeReopenGlow([tabRefKey(only)])).toBe(false);
  });
});

describe("closing listeners", () => {
  it("tells every subscriber which tabs each close is about to remove", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeClosingTabs(first);
    subscribeClosingTabs(second);

    markClosingTabs([epicRef("a")]);
    markClosingTabs([epicRef("b"), epicRef("c")]);

    for (const listener of [first, second]) {
      expect(listener.mock.calls).toEqual([
        [[tabRefKey(epicRef("a"))]],
        [[tabRefKey(epicRef("b")), tabRefKey(epicRef("c"))]],
      ]);
    }
  });

  it("stops notifying a subscriber once it unsubscribes", () => {
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = subscribeClosingTabs(leaving);
    subscribeClosingTabs(staying);

    unsubscribe();
    markClosingTabs([epicRef("a")]);

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });
});
