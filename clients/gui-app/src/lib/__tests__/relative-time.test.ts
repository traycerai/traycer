import { act, cleanup, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRACE_COUNTDOWN_IMMINENT,
  createSharedClock,
  formatClockTime,
  formatGraceCountdown,
  formatRelativeTimestamp,
  formatResetCountdown,
  formatResetDateTime,
  formatResetFullDateTime,
  isFarReset,
  useGraceCountdown,
  useRelativeTimestamp,
} from "@/lib/relative-time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// A fixed instant for the batching/coalescing suite below, distinct from the
// per-describe `now` constants above so nothing here reads as tied to those.
const BASE = Date.parse("2026-06-01T00:00:00.000Z");

describe("formatRelativeTimestamp", () => {
  const now = Date.parse("2026-04-23T12:00:00.000Z");

  it("renders 'Just now' for deltas under one minute", () => {
    expect(formatRelativeTimestamp(now, now)).toBe("Just now");
    expect(formatRelativeTimestamp(now - 30_000, now)).toBe("Just now");
    expect(formatRelativeTimestamp(now - (MINUTE_MS - 1), now)).toBe(
      "Just now",
    );
  });

  it("renders minute buckets with the 'm ago' short form", () => {
    expect(formatRelativeTimestamp(now - MINUTE_MS, now)).toBe("1m ago");
    expect(formatRelativeTimestamp(now - 2 * MINUTE_MS, now)).toBe("2m ago");
    expect(formatRelativeTimestamp(now - 59 * MINUTE_MS, now)).toBe("59m ago");
  });

  it("renders hour buckets with the 'h ago' short form", () => {
    expect(formatRelativeTimestamp(now - HOUR_MS, now)).toBe("1h ago");
    expect(formatRelativeTimestamp(now - 5 * HOUR_MS, now)).toBe("5h ago");
    expect(formatRelativeTimestamp(now - 23 * HOUR_MS, now)).toBe("23h ago");
  });

  it("renders 'Yesterday' for deltas that fall in the 1-day bucket", () => {
    expect(formatRelativeTimestamp(now - DAY_MS, now)).toBe("Yesterday");
    expect(formatRelativeTimestamp(now - (DAY_MS + 6 * HOUR_MS), now)).toBe(
      "Yesterday",
    );
  });

  it("falls back to a short date for older entries", () => {
    const twoDaysAgo = now - 2 * DAY_MS;
    const expected = new Date(twoDaysAgo).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(formatRelativeTimestamp(twoDaysAgo, now)).toBe(expected);

    const lastWeek = now - 7 * DAY_MS;
    const expectedWeek = new Date(lastWeek).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(formatRelativeTimestamp(lastWeek, now)).toBe(expectedWeek);
  });

  it("clamps future timestamps to 'Just now' rather than rendering negative deltas", () => {
    expect(formatRelativeTimestamp(now + 10_000, now)).toBe("Just now");
  });
});

describe("formatResetCountdown", () => {
  const now = Date.parse("2026-04-23T12:00:00.000Z");

  it("renders seconds for deltas under one minute", () => {
    expect(formatResetCountdown(now, now)).toBe("0s");
    expect(formatResetCountdown(now + 999, now)).toBe("1s");
    expect(formatResetCountdown(now + 5_000, now)).toBe("5s");
    expect(formatResetCountdown(now + (MINUTE_MS - 1), now)).toBe("59s");
  });

  it("renders minute buckets once a full minute away", () => {
    expect(formatResetCountdown(now + MINUTE_MS, now)).toBe("1m");
    expect(formatResetCountdown(now + 2 * MINUTE_MS, now)).toBe("2m");
    expect(formatResetCountdown(now + 59 * MINUTE_MS, now)).toBe("59m");
  });

  it("renders hour+minute buckets, omitting minutes when exactly on the hour", () => {
    expect(formatResetCountdown(now + HOUR_MS, now)).toBe("1h");
    expect(formatResetCountdown(now + HOUR_MS + 30 * MINUTE_MS, now)).toBe(
      "1h 30m",
    );
    expect(formatResetCountdown(now + 23 * HOUR_MS, now)).toBe("23h");
  });

  it("renders day buckets past 24 hours", () => {
    expect(formatResetCountdown(now + DAY_MS, now)).toBe("1d");
    expect(formatResetCountdown(now + 4 * DAY_MS, now)).toBe("4d");
  });

  it("clamps a past resetsAt to '0s' rather than a negative duration", () => {
    expect(formatResetCountdown(now - 10_000, now)).toBe("0s");
  });
});

describe("isFarReset", () => {
  const now = Date.parse("2026-04-23T12:00:00.000Z");

  it("is false for a reset under one day away, regardless of a window's nominal duration", () => {
    expect(isFarReset(now + 23 * HOUR_MS, now)).toBe(false);
  });

  it("is true at exactly one day away and beyond", () => {
    expect(isFarReset(now + DAY_MS, now)).toBe(true);
    expect(isFarReset(now + 3 * DAY_MS, now)).toBe(true);
  });
});

describe("formatResetDateTime", () => {
  it("renders a short weekday followed by the time, with no calendar date", () => {
    const formatted = formatResetDateTime(
      Date.parse("2026-07-11T10:35:00.000Z"),
    );
    // Exact weekday/time is TZ/locale-dependent, so assert structure rather
    // than a literal string: a three-letter weekday, then a time with an
    // AM/PM designator, and no year/date digits leaking back in.
    expect(formatted).toMatch(/^[A-Za-z]{3} \d{1,2}:\d{2}\s?[AP]M$/i);
    expect(formatted).not.toContain("2026");
  });

  it("renders the calendar date on roomy surfaces", () => {
    const timestamp = Date.parse("2026-07-11T10:35:00.000Z");
    const formatted = formatResetFullDateTime(timestamp);
    expect(formatted).toContain("2026");
    expect(formatted).not.toBe(formatResetDateTime(timestamp));
  });
});

describe("formatGraceCountdown", () => {
  const now = Date.parse("2026-04-23T12:00:00.000Z");

  it("renders seconds, mixed minutes, and whole minutes", () => {
    expect(formatGraceCountdown(now + 12_000, now)).toBe("12s");
    expect(formatGraceCountdown(now + 2 * MINUTE_MS + 5_000, now)).toBe(
      "2m 5s",
    );
    expect(formatGraceCountdown(now + 2 * MINUTE_MS, now)).toBe("2m");
  });

  it("rounds remaining time up so a 1 ms remainder is 1s, never 0s", () => {
    expect(formatGraceCountdown(now + 1, now)).toBe("1s");
    expect(formatGraceCountdown(now + 1_001, now)).toBe("2s");
  });

  it("degrades to GRACE_COUNTDOWN_IMMINENT at and past the deadline", () => {
    expect(formatGraceCountdown(now, now)).toBe(GRACE_COUNTDOWN_IMMINENT);
    expect(formatGraceCountdown(now - 5_000, now)).toBe(
      GRACE_COUNTDOWN_IMMINENT,
    );
    expect(GRACE_COUNTDOWN_IMMINENT).toBe("any moment now");
  });

  it("never renders the string 0s for any input", () => {
    const samples = [
      formatGraceCountdown(now + 1, now),
      formatGraceCountdown(now, now),
      formatGraceCountdown(now - 1, now),
      formatGraceCountdown(now - 10_000, now),
      formatGraceCountdown(now + MINUTE_MS, now),
      formatGraceCountdown(now + MINUTE_MS - 1, now),
    ];
    for (const label of samples) {
      // Falsification: change Math.ceil to Math.floor in formatGraceCountdown and THIS assertion must go red.
      expect(label).not.toBe("0s");
      expect(label).not.toMatch(/\b0s\b/);
    }
  });
});

describe("useGraceCountdown", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("returns null when there is no deadline", () => {
    const { result } = renderHook(() => useGraceCountdown(null));
    expect(result.current).toBeNull();
  });

  it("re-renders with a new label after one second on the shared clock", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const { result } = renderHook(() => useGraceCountdown(now + 5_000));
    expect(result.current).toBe("5s");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe("4s");
  });
});

describe("formatClockTime", () => {
  it("renders a 12-hour time with an AM/PM designator and no zero-padded hour", () => {
    const formatted = formatClockTime(
      new Date(2026, 6, 11, 15, 0, 0).getTime(),
    );
    expect(formatted).toMatch(/^\d{1,2}:\d{2}\s?[AP]M$/i);
    expect(formatted).not.toMatch(/^0\d:/);
    expect(formatted).toMatch(/[AP]M/i);
  });
});

/**
 * The cost of subscribing, which is a property of the clock and not of any
 * hook. Counted here rather than through rendered rows on purpose: React
 * batches, and batching is exactly what would hide a quadratic notify.
 *
 * The two tests are a PAIR and neither means much alone. "Linear" is trivially
 * satisfied by a subscribe that never notifies anyone - which is precisely the
 * regression D170 was written to prevent - so the second test is the control
 * that keeps the first honest.
 */
describe("createSharedClock subscribe cost", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Total listener invocations when `count` subscribers mount in one tick. */
  function notificationsForMassMount(count: number): number {
    const clock = createSharedClock(MINUTE_MS);
    let calls = 0;
    const unsubscribes: (() => void)[] = [];
    for (let index = 0; index < count; index += 1) {
      unsubscribes.push(
        clock.subscribe(() => {
          calls += 1;
        }),
      );
    }
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
    return calls;
  }

  it("costs at most one notification per subscriber on a mass mount", () => {
    vi.useFakeTimers();
    // Fake timers freeze `Date.now`, so every subscribe below lands on the same
    // millisecond - one instance of the mass-mount shape (300 worktree rows
    // arriving in one commit), not the only one: a real mass mount can equally
    // spread across several milliseconds, which is what the batching-contract
    // suite below pins separately (per-millisecond and shared-millisecond-bucket
    // variants). The current implementation notifies ZERO times here (the
    // first subscriber's `startIfNeeded` samples, and nobody after it finds the
    // clock moved); the bound is written as linear rather than as 0 so a future
    // legitimate per-subscriber notification does not read as a regression.
    //
    // Falsification: delete the `now > sampledNow` guard in `subscribe` and the
    // k-th subscriber wakes k listeners, so these become 1, 1_275 and 45_150 -
    // the last two assertions go red by one and two orders of magnitude.
    expect(notificationsForMassMount(1)).toBeLessThanOrEqual(1);
    expect(notificationsForMassMount(50)).toBeLessThanOrEqual(50);
    expect(notificationsForMassMount(300)).toBeLessThanOrEqual(300);
  });

  it("corrects the FIRST subscriber when the sample predates its render", () => {
    vi.useFakeTimers();
    // The module-level case - a clock constructed long before this component
    // mounted - and precisely the one the count above CANNOT see, because a
    // freshly built clock is sampled at the instant its first subscriber
    // arrives. `startIfNeeded` re-samples on the way in, so a guard comparing
    // against `sampledNow` AFTER that call finds the two equal, skips, and
    // leaves the newcomer rendering the old sample: D170 undone by the very
    // fix that made subscribe linear. This test exists because that is not
    // hypothetical - it is what the first version of the guard did.
    //
    // Falsification: move the `sampleTheRenderSaw` capture below
    // `startIfNeeded()` and this goes red while the mass-mount count stays
    // green.
    const clock = createSharedClock(MINUTE_MS);
    const bornAt = clock.sampledNow();
    vi.setSystemTime(bornAt + 30_000);

    let notified = 0;
    const stop = clock.subscribe(() => {
      notified += 1;
    });

    expect(notified).toBe(1);
    expect(clock.sampledNow()).toBe(bornAt + 30_000);
    stop();
  });

  it("still corrects existing listeners when a subscriber arrives after the clock moved", () => {
    vi.useFakeTimers();
    const clock = createSharedClock(MINUTE_MS);
    let firstCalls = 0;
    const stopFirst = clock.subscribe(() => {
      firstCalls += 1;
    });
    const startedAt = clock.sampledNow();
    expect(firstCalls).toBe(0);

    // 900ms in, between fires: the sample the first row is rendering against is
    // now stale, and D170 says the newcomer's subscribe has to correct it for
    // everyone - not just for itself, since the tick is shared.
    vi.setSystemTime(startedAt + 900);
    const stopLate = clock.subscribe(() => undefined);

    // Falsification: remove the re-sample/notify block from `subscribe`, or
    // widen its guard so it never runs, and BOTH of these go red. That is the
    // assertion the linearity bound above cannot make on its own.
    expect(firstCalls).toBe(1);
    expect(clock.sampledNow()).toBe(startedAt + 900);

    stopFirst();
    stopLate();
  });
});

/**
 * F13 batching/coalescing contract pins: one immediate correction per batch,
 * one bounded trailing sweep for the rest, generation invalidation on idle.
 */
describe("createSharedClock batching contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Batch size N, +1ms advance before each subscribe (no interval timer ever
   * runs - `setSystemTime` never fires one). Predicted totals: 1, 51, 301.
   */
  it("costs one immediate notification plus one bounded trailing sweep, not one notification per subscriber", async () => {
    vi.useFakeTimers();
    const predictions: Array<{ count: number; expectedTotal: number }> = [
      { count: 1, expectedTotal: 1 },
      { count: 50, expectedTotal: 51 },
      { count: 300, expectedTotal: 301 },
    ];

    for (const { count, expectedTotal } of predictions) {
      vi.setSystemTime(BASE);
      const clock = createSharedClock(MINUTE_MS);
      let calls = 0;
      const stops: Array<() => void> = [];

      for (let i = 1; i <= count; i += 1) {
        vi.setSystemTime(BASE + i);
        stops.push(
          clock.subscribe(() => {
            calls += 1;
          }),
        );
        // Sample AND snapshot are both fresh synchronously after each real
        // time advance - a moved sample alone would not correct React.
        expect(clock.sampledNow()).toBe(BASE + i);
        expect(clock.getSnapshot()).toBe(i);
      }

      expect(calls).toBe(1); // only the first subscribe's immediate correction

      await Promise.resolve();
      await Promise.resolve();

      // Falsification A: revert `notifySubscriptionRefresh` to notify
      // unconditionally instead of returning early while a refresh is
      // pending - totals become 1, 1_275, 45_150 (the quadratic shape).
      // Falsification B: delete the `queueMicrotask` trailing sweep - `calls`
      // never grows past 1 for count > 1.
      expect(calls).toBe(expectedTotal);
      expect(calls).toBeLessThanOrEqual(2 * count); // negative half: not quadratic

      for (const stop of stops) stop();
    }
  });

  /**
   * Same totals via shared-millisecond buckets (10 subscribers per advance,
   * first bucket aged 5s past construction): only the first seat of each
   * bucket finds the clock moved, but the sync/trailing split is decided by
   * whether a refresh is pending, not by how many distinct ms were touched.
   */
  it("gives the same totals when subscribers arrive in shared-millisecond buckets, with the first bucket aged", async () => {
    vi.useFakeTimers();
    const predictions: Array<{ count: number; expectedTotal: number }> = [
      { count: 50, expectedTotal: 51 },
      { count: 300, expectedTotal: 301 },
    ];
    const SEATS_PER_BUCKET = 10;

    for (const { count, expectedTotal } of predictions) {
      vi.setSystemTime(BASE);
      const clock = createSharedClock(MINUTE_MS);
      let calls = 0;
      const stops: Array<() => void> = [];
      const bucketCount = count / SEATS_PER_BUCKET;
      const agedFirstBucketAt = BASE + 5_000;

      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        vi.setSystemTime(agedFirstBucketAt + bucket);
        for (let seat = 0; seat < SEATS_PER_BUCKET; seat += 1) {
          stops.push(
            clock.subscribe(() => {
              calls += 1;
            }),
          );
        }
        // Sample and snapshot are both current synchronously at the end of
        // each bucket - the snapshot only actually moves on the bucket's
        // first seat, but every seat sees a value consistent with `now`.
        expect(clock.sampledNow()).toBe(agedFirstBucketAt + bucket);
        expect(clock.getSnapshot()).toBe(bucket + 1);
      }

      expect(calls).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(expectedTotal);
      expect(calls).toBeLessThanOrEqual(2 * count);

      for (const stop of stops) stop();
    }
  });

  /**
   * Control: a fully frozen clock (nobody ever sees it move) costs ZERO
   * notifications, catching a guard that fires gratuitously (e.g. weakened
   * from `now > sampleTheRenderSaw` to `now >= sampleTheRenderSaw`, made
   * unconditional, or removed outright). With a frozen `BASE`, every
   * subscription samples `now === sampleTheRenderSaw`, so `>=` (unlike
   * `!==`, which stays false on an equal sample too and would leave this
   * control green) fires on the very first subscription.
   */
  it("costs zero notifications on a fully frozen clock (frozen-time control)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clock = createSharedClock(MINUTE_MS);
    let calls = 0;
    const stops: Array<() => void> = [];
    for (let i = 0; i < 50; i += 1) {
      stops.push(
        clock.subscribe(() => {
          calls += 1;
        }),
      );
    }
    // Falsification: weaken the guard to fire unconditionally, remove it
    // outright, or change `now > sampleTheRenderSaw` to
    // `now >= sampleTheRenderSaw` - any of these fires on the very first
    // subscription (this frozen `now` always EQUALS `sampleTheRenderSaw`),
    // making this >0 with nothing ever moving. (A `!==` comparison is NOT
    // a falsifier here: an equal sample makes it false too, same as `>`,
    // so that edit alone would leave this control green.)
    expect(calls).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(0);
    for (const stop of stops) stop();
  });

  /**
   * An old sibling must synchronously observe the batch's FIRST correction
   * (D170, unaffected by coalescing) and the batch's FINAL sample once the
   * trailing sweep fires - captured from INSIDE its own callback, not read
   * from the clock externally.
   */
  it("an old sibling's own callback observes the batch's first correction synchronously and the final sample at flush", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clock = createSharedClock(MINUTE_MS);

    const oldObservedSamples: number[] = [];
    const stopOld = clock.subscribe(() => {
      oldObservedSamples.push(clock.sampledNow());
    });
    expect(oldObservedSamples).toEqual([]); // same ms as construction

    vi.setSystemTime(BASE + 900);
    const stopB1 = clock.subscribe(() => undefined); // batch's first mover
    expect(oldObservedSamples).toEqual([BASE + 900]);

    vi.setSystemTime(BASE + 1_800);
    const stopB2 = clock.subscribe(() => undefined); // same batch, pre-flush
    // Not told about the second move yet - only the trailing sweep does that.
    expect(oldObservedSamples).toEqual([BASE + 900]);

    await Promise.resolve();
    await Promise.resolve();

    // Falsification: delete only the trailing `queueMicrotask` sweep (keep
    // the immediate `notifyListeners()` call). `oldObservedSamples` then
    // never grows past `[BASE + 900]`.
    expect(oldObservedSamples).toEqual([BASE + 900, BASE + 1_800]);

    stopOld();
    stopB1();
    stopB2();
  });

  /**
   * The generation guard, isolated by manually capturing and controlling
   * exactly which queued microtask runs when. An ordinary "drain everything
   * with `await`" test cannot distinguish this: draining both callbacks
   * together produces the same final counts whether or not the guard exists,
   * because the old callback's own tick-vs-`lastNotifiedTick` check happens
   * to agree with the new one by the time both have run. Only running the
   * OLD callback alone, before the NEW one, exposes the difference.
   */
  it("boundary: an old batch's stale sweep is inert alone; the new generation's own sweep delivers the final sample", () => {
    vi.useFakeTimers();
    const capturedCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation(
      (callback: () => void) => {
        capturedCallbacks.push(callback);
      },
    );

    vi.setSystemTime(BASE);
    const clock = createSharedClock(MINUTE_MS);

    // Old batch: A (no correction), then B 5s later - generation 1's sweep
    // queued, A+B notified immediately.
    let aCalls = 0;
    const stopA = clock.subscribe(() => {
      aCalls += 1;
    });
    vi.setSystemTime(BASE + 5_000);
    let bCalls = 0;
    const stopB = clock.subscribe(() => {
      bCalls += 1;
    });
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
    expect(capturedCallbacks).toHaveLength(1);
    const oldSweep = capturedCallbacks[0];

    // Everyone leaves before the old sweep fires - the clock goes idle.
    stopA();
    stopB();

    // New batch leads with C, 5s later: generation 2, its own sweep queued,
    // C notified immediately.
    vi.setSystemTime(BASE + 10_000);
    let cCalls = 0;
    const stopC = clock.subscribe(() => {
      cCalls += 1;
    });
    expect(cCalls).toBe(1);
    expect(capturedCallbacks).toHaveLength(2);
    const newSweep = capturedCallbacks[1];

    // D advances the sample further, 5s later, while the NEW sweep is still
    // pending - D's own subscribe finds a refresh already pending and is
    // folded into that sweep instead of getting an immediate call, but its
    // sample/snapshot are already fresh synchronously.
    vi.setSystemTime(BASE + 15_000);
    let dCalls = 0;
    const stopD = clock.subscribe(() => {
      dCalls += 1;
    });
    expect(dCalls).toBe(0);
    expect(clock.sampledNow()).toBe(BASE + 15_000);
    expect(clock.getSnapshot()).toBe(3);
    expect(capturedCallbacks).toHaveLength(2); // no third sweep queued

    // Execute ONLY the old (generation-1) sweep.
    // Falsification: delete the `pendingRefreshGeneration !== generation`
    // check inside the queued callback - the old sweep then notifies C/D
    // early off the CURRENT (already-advanced) tick and clears the new
    // generation's pending marker, so `cCalls`/`dCalls` change here already.
    oldSweep();
    expect(cCalls).toBe(1); // unchanged - the old sweep is a complete no-op
    expect(dCalls).toBe(0); // unchanged - D got zero further notifications

    // Now execute the new (generation-2) sweep: it delivers the final sample.
    newSweep();
    expect(cCalls).toBe(2);
    expect(dCalls).toBe(1);
    expect(clock.sampledNow()).toBe(BASE + 15_000);
    expect(clock.getSnapshot()).toBe(3);

    stopC();
    stopD();
  });

  /**
   * Negative control for the boundary pin above: a subscriber sharing the
   * mover's EXACT millisecond never finds the clock moved, so it is neither
   * notified immediately nor swept in later - not even after every pending
   * sweep drains.
   */
  it("negative control: a subscriber sharing the mover's exact millisecond is never notified", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clock = createSharedClock(MINUTE_MS);
    const stopLeader = clock.subscribe(() => undefined);

    vi.setSystemTime(BASE + 1_000);
    let moverCalls = 0;
    const stopMover = clock.subscribe(() => {
      moverCalls += 1;
    });
    expect(moverCalls).toBe(1); // the mover itself IS notified

    let sameMsCalls = 0;
    const stopSameMs = clock.subscribe(() => {
      sameMsCalls += 1;
    });
    expect(sameMsCalls).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    // Falsification: have the trailing sweep notify unconditionally rather
    // than gating on `lastNotifiedTick !== tick` - this becomes 1.
    expect(sameMsCalls).toBe(0);

    stopLeader();
    stopMover();
    stopSameMs();
  });
});

/**
 * F13: the sample-capture-before-`startIfNeeded` ordering, pinned across an
 * idle -> restart cycle on the SAME clock instance. A fresh instance is
 * sampled at construction and can never exercise the stale case; only an
 * instance aged WHILE idle, before being resubscribed, can.
 */
describe("createSharedClock restart after going idle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("corrects a subscriber that restarts the same aged clock instance, across two restart cycles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clock = createSharedClock(MINUTE_MS);

    let firstCalls = 0;
    const stopFirst = clock.subscribe(() => {
      firstCalls += 1;
    });
    expect(firstCalls).toBe(0); // same millisecond as construction
    expect(clock.getSnapshot()).toBe(0);
    stopFirst(); // last unsubscribe -> clock goes idle, interval cleared

    // Age the SAME clock instance while it sits idle.
    vi.setSystemTime(BASE + 45_000);
    let restartedCalls = 0;
    const stopRestarted = clock.subscribe(() => {
      restartedCalls += 1;
    });
    // Falsification: move `const sampleTheRenderSaw = sampledNow` to AFTER
    // `startIfNeeded()`. `startIfNeeded` itself resamples `sampledNow` on
    // this idle->active transition, so `sampledNow()` would still read
    // `BASE + 45_000` correctly even under the bug - what actually breaks is
    // that `sampleTheRenderSaw` then equals `now`, the guard never fires,
    // `getSnapshot()` never bumps past 0, and `restartedCalls` stays 0: the
    // snapshot React reads never changes, so nothing re-renders even though
    // the underlying sample was already fixed.
    expect(restartedCalls).toBe(1);
    expect(clock.getSnapshot()).toBe(1);
    expect(clock.sampledNow()).toBe(BASE + 45_000);
    stopRestarted(); // idle again

    // A second restart cycle on the SAME instance, to rule out this only
    // working once by accident of leftover state.
    vi.setSystemTime(BASE + 45_000 + 12_000);
    let secondRestartCalls = 0;
    const stopSecondRestart = clock.subscribe(() => {
      secondRestartCalls += 1;
    });
    expect(secondRestartCalls).toBe(1);
    expect(clock.getSnapshot()).toBe(2);
    expect(clock.sampledNow()).toBe(BASE + 57_000);
    stopSecondRestart();
  });
});

/**
 * F13: minute/second clock separation and interval lifecycle. `useGraceCountdown`
 * is the only consumer of the second clock; every other hook here shares the
 * minute clock.
 */
describe("minute/second clock separation and interval lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ticking the second clock does not re-render a minute-clock consumer", () => {
    vi.useFakeTimers();
    const createdAt = Date.now() - 30_000;

    // A vi.fn() probe called from a layout effect (post-render), not a write
    // to an outer variable during render (D194).
    const minuteRenderProbe = vi.fn();
    const { result: minuteResult, unmount: unmountMinute } = renderHook(() => {
      const label = useRelativeTimestamp(createdAt);
      useLayoutEffect(() => {
        minuteRenderProbe();
      });
      return label;
    });
    expect(minuteResult.current).toBe("Just now");
    // Captured AFTER mount settles, not assumed to be 1: the minute clock is
    // a module singleton shared with every other test in this file.
    const baselineRenderCount = minuteRenderProbe.mock.calls.length;

    const deadline = Date.now() + 10_000;
    const { result: graceResult, unmount: unmountGrace } = renderHook(() =>
      useGraceCountdown(deadline),
    );
    expect(graceResult.current).toBe("10s");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // Falsification 1: if `useGraceCountdown` read the MINUTE clock's
    // subscribe/getSnapshot instead of `secondClock`'s, this itself goes red
    // - nothing ticks within 1s on the minute cadence.
    expect(graceResult.current).toBe("9s");
    // Falsification 2: if `secondClock` were the SAME instance as
    // `minuteClock` (constructed once and reused for both cadences instead
    // of its own `createSharedClock(SECOND_MS)`), the tick above would also
    // bump the minute clock's snapshot and this would go red.
    expect(minuteRenderProbe.mock.calls.length).toBe(baselineRenderCount);

    unmountMinute();
    unmountGrace();
  });

  it("pure formatters never start a timer; only subscribing to a clock does", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const now = Date.now();

    formatRelativeTimestamp(now - 30_000, now);
    formatGraceCountdown(now + 5_000, now);
    formatResetCountdown(now + 5_000, now);
    // Falsification: give a formatter its own internal `setInterval`-driven
    // cache instead of taking `now` as a plain parameter.
    expect(setIntervalSpy).not.toHaveBeenCalled();

    const clock = createSharedClock(MINUTE_MS);
    const stop = clock.subscribe(() => undefined);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stopping the last subscriber on one cadence's clock does not touch the other cadence's interval", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const minuteLikeClock = createSharedClock(MINUTE_MS);
    const secondLikeClock = createSharedClock(1_000);

    const stopMinuteLike = minuteLikeClock.subscribe(() => undefined);
    const secondTicks: number[] = [];
    const stopSecondLike = secondLikeClock.subscribe(() => {
      secondTicks.push(secondLikeClock.getSnapshot());
    });

    stopMinuteLike(); // the only, and therefore last, subscriber on this clock
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // Falsification: if `stopIfIdle` cleared a shared/global handle instead
    // of the one captured in THIS clock's own closure, the second-like
    // clock's interval would have been torn down too and no tick would ever
    // arrive.
    expect(secondTicks.length).toBeGreaterThan(0);

    stopSecondLike();
  });

  /**
   * Old-flush/new-generation isolation via ordinary draining (`await`),
   * paired with the explicit boundary pin above that isolates the single
   * step this one cannot.
   */
  it("a stale trailing sweep from an emptied-out batch cannot notify a newer generation after the clock restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clock = createSharedClock(MINUTE_MS);

    let firstCalls = 0;
    const stopA = clock.subscribe(() => {
      firstCalls += 1;
    });
    vi.setSystemTime(BASE + 5_000);
    let secondCalls = 0;
    const stopB = clock.subscribe(() => {
      secondCalls += 1;
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);

    // Everyone leaves before generation 1's trailing sweep fires - idle.
    stopA();
    stopB();

    vi.setSystemTime(BASE + 10_000);
    let thirdCalls = 0;
    const stopC = clock.subscribe(() => {
      thirdCalls += 1;
    });
    const callsRightAfterSubscribe = thirdCalls;

    await Promise.resolve();
    await Promise.resolve();

    // Falsification: delete `pendingRefreshGeneration = null` from
    // `stopIfIdle`. C's own `subscribe` then finds a refresh already
    // "pending" (generation 1, never invalidated) and skips its own
    // immediate notify (`callsRightAfterSubscribe` becomes 0); generation 1's
    // stale sweep then still matches its own recorded generation and
    // notifies C anyway, so `thirdCalls` ends at 1 from the WRONG sweep -
    // `thirdCalls !== callsRightAfterSubscribe` (1 vs 0).
    expect(callsRightAfterSubscribe).toBe(1);
    expect(thirdCalls).toBe(callsRightAfterSubscribe);

    stopC();
  });
});
