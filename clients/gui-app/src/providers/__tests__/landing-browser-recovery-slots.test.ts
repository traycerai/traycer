import { describe, expect, it } from "vitest";
import {
  landingBrowserRecoveryQueuesEqual,
  selectLandingBrowserRecoveryHostIds,
  yieldLandingBrowserRecoveryHosts,
  type LandingBrowserRecoveryQueue,
} from "@/providers/landing-browser-recovery-slots";

const CAP = 2;

function queue(entries: Record<string, number>): LandingBrowserRecoveryQueue {
  return new Map(Object.entries(entries));
}

function select(args: {
  readonly candidateHostIds: readonly string[];
  readonly queue?: LandingBrowserRecoveryQueue;
}): readonly string[] {
  return selectLandingBrowserRecoveryHostIds({
    candidateHostIds: args.candidateHostIds,
    queue: args.queue ?? new Map(),
    cap: CAP,
  });
}

function yieldHosts(args: {
  readonly queue: LandingBrowserRecoveryQueue;
  readonly candidateHostIds: readonly string[];
  readonly yieldingHostIds: readonly string[];
}): LandingBrowserRecoveryQueue {
  return yieldLandingBrowserRecoveryHosts({
    queue: args.queue,
    candidateHostIds: args.candidateHostIds,
    yieldingHostIds: args.yieldingHostIds,
  });
}

describe("selectLandingBrowserRecoveryHostIds", () => {
  it("takes the oldest tombstones first while nothing has yielded", () => {
    expect(select({ candidateHostIds: ["a", "b", "c"] })).toEqual(["a", "b"]);
  });

  // The starvation this policy exists for: two devices with a route that never
  // answer would otherwise hold both slots for as long as their tombstones
  // last, which is for as long as they do not answer.
  it("ranks a device that yielded behind one that never has", () => {
    expect(
      select({
        candidateHostIds: ["a", "b", "c"],
        queue: queue({ a: 0, b: 1 }),
      }),
    ).toEqual(["c", "a"]);
  });

  it("rotates by how long ago each yielded", () => {
    expect(
      select({
        candidateHostIds: ["a", "b", "c"],
        queue: queue({ a: 2, b: 1, c: 0 }),
      }),
    ).toEqual(["c", "b"]);
  });

  // The whole selection runs while rendering, so it may never consult the
  // clock: a list that changed with `Date.now()` would churn streams on a
  // re-render no input had moved.
  it("gives the same answer for the same inputs, whenever it is asked", () => {
    const candidateHostIds = ["a", "b", "c"];
    const held = queue({ a: 3, c: 1 });
    expect(select({ candidateHostIds, queue: held })).toEqual(
      select({ candidateHostIds, queue: held }),
    );
  });

  it("mounts every candidate when there are fewer of them than slots", () => {
    expect(select({ candidateHostIds: ["a"], queue: queue({ a: 7 }) })).toEqual(
      ["a"],
    );
  });
});

describe("yieldLandingBrowserRecoveryHosts", () => {
  it("sends a silent cohort to the back, in the order it gave up", () => {
    const next = yieldHosts({
      queue: new Map(),
      candidateHostIds: ["a", "b", "c"],
      yieldingHostIds: ["a", "b"],
    });
    expect(next.get("a")).toBe(0);
    expect(next.get("b")).toBe(1);
    expect(select({ candidateHostIds: ["a", "b", "c"], queue: next })).toEqual([
      "c",
      "a",
    ]);
  });

  it("puts a device that yields twice behind everyone who yielded since", () => {
    const first = yieldHosts({
      queue: new Map(),
      candidateHostIds: ["a", "b", "c"],
      yieldingHostIds: ["a"],
    });
    const second = yieldHosts({
      queue: first,
      candidateHostIds: ["a", "b", "c"],
      yieldingHostIds: ["b"],
    });
    const third = yieldHosts({
      queue: second,
      candidateHostIds: ["a", "b", "c"],
      yieldingHostIds: ["a"],
    });
    expect(third.get("b")).toBeLessThan(third.get("a") ?? Number.NaN);
    expect(select({ candidateHostIds: ["a", "b", "c"], queue: third })).toEqual(
      ["c", "b"],
    );
  });

  // A device that leaves has either drained its tombstones or lost its route.
  // Either way its next appearance is new evidence, not the place in the queue
  // it left behind - and the map must not grow with every device the session
  // ever saw.
  it("forgets a device that is no longer a candidate", () => {
    const next = yieldHosts({
      queue: queue({ a: 0, b: 1 }),
      candidateHostIds: ["b"],
      yieldingHostIds: [],
    });
    expect(next.size).toBe(1);
    expect(next.get("b")).toBe(1);
  });

  it("ignores a yield from a device that is no longer a candidate", () => {
    const next = yieldHosts({
      queue: new Map(),
      candidateHostIds: ["b"],
      yieldingHostIds: ["a"],
    });
    expect(next.size).toBe(0);
  });

  // The bridge feeds this back into state, so a yield that changes nothing has
  // to compare equal - otherwise it re-renders and re-dials for nothing.
  it("returns an equal queue when nobody yields and nobody left", () => {
    const held = queue({ a: 0, b: 1 });
    const next = yieldHosts({
      queue: held,
      candidateHostIds: ["a", "b"],
      yieldingHostIds: [],
    });
    expect(landingBrowserRecoveryQueuesEqual(held, next)).toBe(true);
  });
});

describe("landingBrowserRecoveryQueuesEqual", () => {
  it("separates a different order from a different membership", () => {
    expect(
      landingBrowserRecoveryQueuesEqual(queue({ a: 0 }), queue({ a: 1 })),
    ).toBe(false);
    expect(
      landingBrowserRecoveryQueuesEqual(queue({ a: 0 }), queue({ b: 0 })),
    ).toBe(false);
    expect(
      landingBrowserRecoveryQueuesEqual(
        queue({ a: 0, b: 1 }),
        queue({ b: 1, a: 0 }),
      ),
    ).toBe(true);
  });
});
