import { act, cleanup, renderHook } from "@testing-library/react";
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
} from "@/lib/relative-time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
    // millisecond - the shape of a real mass mount, 300 worktree rows arriving
    // in one commit. The current implementation notifies ZERO times here (the
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
