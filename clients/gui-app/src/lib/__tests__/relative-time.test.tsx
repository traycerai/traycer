import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import {
  GRACE_COUNTDOWN_IMMINENT,
  createSharedClock,
  formatClockTime,
  formatCompactRelativeTime,
  formatFullTimestamp,
  formatGraceCountdown,
  formatMessageTime,
  formatMessageTimeWithSeconds,
  formatRelativeTimestamp,
  formatResetCountdown,
  formatResetDateTime,
  formatResetFullDateTime,
  formatWaitTime,
  isFarReset,
  useCompactRelativeTime,
  useGraceCountdown,
  useIsFarReset,
  useMessageTime,
  useRelativeTimestamp,
  useResetCountdown,
  useSampledNow,
} from "@/lib/relative-time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// A fixed instant for the batching/coalescing suite below, distinct from the
// per-describe `now` constants above so nothing here reads as tied to those.
const BASE = Date.parse("2026-06-01T00:00:00.000Z");

/**
 * One named part of a date/time, rendered by the SAME resolved locale the
 * formatters under test use (`undefined`).
 *
 * `vitest.config.ts` pins no locale, so a fixture written as a Latin literal -
 * `/[AP]M/`, `"2026"` - asserts ENGLISH rather than the property it means, and
 * goes red on a formatter that is behaving correctly: ja-JP renders "午後3:00"
 * (the designator leads, and is never "AM"/"PM"), th-TH prints the Buddhist
 * year 2569, ar-EG uses Arabic-Indic digits. Deriving the token keeps the claim
 * about the FORMAT. Same anchor the `formatFullTimestamp` case at the bottom of
 * this file builds inline, for the same reason.
 *
 * Throws rather than returning null when the part is absent: a missing
 * `dayPeriod` under `hour12: true` means the assertion below has nothing to
 * check, which is a broken test, not a passing one.
 */
function dateTimePart(
  timestamp: number,
  options: Intl.DateTimeFormatOptions,
  type: Intl.DateTimeFormatPartTypes,
): string {
  const part = new Intl.DateTimeFormat(undefined, options)
    .formatToParts(new Date(timestamp))
    .find((candidate) => candidate.type === type);
  if (part === undefined) {
    throw new Error(`the format produced no ${type} part to anchor on`);
  }
  return part.value;
}

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

  it("adds the year to a short date from another year, and only then", () => {
    // Local calendar dates: the year boundary is the viewer's.
    const today = new Date(2026, 3, 23, 12, 0, 0).getTime();
    const lastYear = new Date(2025, 10, 3, 12, 0, 0).getTime();
    const earlierThisYear = new Date(2026, 0, 9, 12, 0, 0).getTime();
    const withYear = new Date(lastYear).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const withoutYear = new Date(earlierThisYear).toLocaleDateString(
      undefined,
      { month: "short", day: "numeric" },
    );

    expect(formatRelativeTimestamp(lastYear, today)).toBe(withYear);
    expect(formatCompactRelativeTime(lastYear, today)).toBe(withYear);
    expect(formatRelativeTimestamp(earlierThisYear, today)).toBe(withoutYear);
    expect(formatCompactRelativeTime(earlierThisYear, today)).toBe(withoutYear);
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

const RESET_FULL_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
};

describe("formatResetDateTime", () => {
  it("renders a short weekday followed by the time, with no calendar date", () => {
    const resetsAt = Date.parse("2026-07-11T10:35:00.000Z");
    const formatted = formatResetDateTime(resetsAt);
    // Composed from the same locale-resolved pieces the source uses rather
    // than matched against `/^[A-Za-z]{3} \d{1,2}:\d{2} ?[AP]M$/`: that regex
    // requires a LATIN weekday and an ENGLISH designator, so under ja-JP
    // ("土 午後7:35") every assertion here failed on a correct formatter. The
    // options are restated rather than imported, so an option drifting in the
    // source (a long weekday, a dropped `hour12`, a date creeping back in)
    // still shows up as a difference.
    const expectedWeekday = new Date(resetsAt).toLocaleDateString(undefined, {
      weekday: "short",
    });
    const expectedTime = new Date(resetsAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    expect(formatted).toBe(`${expectedWeekday} ${expectedTime}`);
    // Anchored independently of the equality above, which still passes if the
    // source and this fixture ever drift to the same wrong options. The
    // designator is what the explicit `hour12: true` exists for.
    expect(formatted).toContain(
      dateTimePart(
        resetsAt,
        { hour: "numeric", minute: "2-digit", hour12: true },
        "dayPeriod",
      ),
    );
    // No year/date leaking back in - the point of the shorter form. Read out
    // of the formatter rather than written as "2026": under th-TH the year is
    // 2569 and under ar-EG it is ٢٠٢٦, so the ASCII literal was a negative
    // that could never fail there.
    expect(formatted).not.toContain(
      dateTimePart(resetsAt, { year: "numeric" }, "year"),
    );
  });

  it("renders the calendar date on roomy surfaces", () => {
    const timestamp = Date.parse("2026-07-11T10:35:00.000Z");
    const formatted = formatResetFullDateTime(timestamp);
    // Same year anchor as above, in the positive direction: this is the form
    // that restores the year, and a hard-coded "2026" appears nowhere in it
    // under a non-Gregorian calendar or a non-Latin numbering system.
    expect(formatted).toContain(
      dateTimePart(timestamp, RESET_FULL_OPTIONS, "year"),
    );
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

  // Deliberately NOT pinned to a fixed system time, which reads like the
  // hermetic choice and is the one edit that would break this.
  //
  // `useGraceCountdown` reads the module-level `secondClock`, but
  // `vi.setSystemTime` moves the SYSTEM clock, not any `SharedClock`'s
  // `sampledNow`: an instance re-samples only inside its own `subscribe`,
  // `startIfNeeded` or interval fire. Every `BASE` suite in this file builds
  // fresh instances with `createSharedClock(...)` and never subscribes
  // `secondClock` or `minuteClock`, so no suite order can hand this one a
  // `BASE` sample. And `secondClock` is idle here - every consumer above
  // unmounts through `cleanup()` - so `startIfNeeded` re-samples at THIS
  // test's `Date.now()` on the way in. The `now > sampleTheRenderSaw` guard
  // decides whether the newcomer RE-RENDERS, not whether the sample is fresh.
  //
  // What the first render (before subscribe) does read is the sample the
  // previous test left, and that only shows through when the carried sample is
  // not strictly older than `Date.now()` - no re-render, so the first label
  // stands. The only thing here that can push `secondClock` ahead of the real
  // clock is the 1s fake advance in the minute/second suite, and real time
  // elapses between tests, so the carried skew stays under one second and the
  // rounded-up label is still "5s". A future test that advances `secondClock`
  // by a second or more under fake timers would break that bound - re-sample
  // it through a throwaway mount rather than pinning a system time.
  //
  // Pinning one is what fails: `BASE` is a FIXED instant while every sample
  // this file leaves behind comes from the real clock, so their order depends
  // on when the run happens. With `BASE` in the past (it is), the guard never
  // fires, nothing re-renders, and the only render computes a 5s deadline
  // against a sample months past it - `GRACE_COUNTDOWN_IMMINENT`, not "5s".
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

/**
 * Compiled-mode pins for the MINUTE-clock hooks, the same shape as
 * `useGraceCountdown`'s cell above: each builds its own fake-timer window
 * and asserts the label one minute tick must produce. They pin the class the
 * live grace-card freeze belonged to - the compiler memoizes a render-time
 * read of `sampledNowOf()` on inputs the clock's tick never changes, so the
 * leaf re-renders on every tick and returns its FIRST render's value.
 * `relative-time.ts` is in `REACT_COMPILER_REGRESSION_FILES`, so these run
 * compiled; uncompiled, this class is invisible.
 */
describe("minute-clock hooks re-render with a NEW value after a live tick (compiled)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("useSampledNow: the sampled instant advances after a minute tick", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSampledNow());
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    // Falsification: the compiler memoizes `sampledNowOf()` on no changing
    // input (the hook takes no argument at all), so a regressed build returns
    // `first` again here instead of the freshly ticked sample.
    expect(result.current).toBeGreaterThan(first);
  });

  it("useRelativeTimestamp: the label crosses from 'Just now' to '1m ago' after a minute tick", () => {
    vi.useFakeTimers();
    const createdAt = Date.now();
    const { result } = renderHook(() => useRelativeTimestamp(createdAt));
    expect(result.current).toBe("Just now");
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    // Falsification: the compiler memoizes `formatRelativeTimestamp(createdAt,
    // sampledNowOf())` on `createdAt` alone (the only prop-like input it sees),
    // so a regressed build still reads "Just now" here.
    expect(result.current).toBe("1m ago");
  });

  it("useCompactRelativeTime: the label crosses from 'now' to '1m' after a minute tick", () => {
    vi.useFakeTimers();
    const timestamp = Date.now();
    const { result } = renderHook(() => useCompactRelativeTime(timestamp));
    expect(result.current).toBe("now");
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    expect(result.current).toBe("1m");
  });

  it("useResetCountdown: the countdown decrements after a minute tick", () => {
    vi.useFakeTimers();
    const resetsAt = Date.now() + 3 * MINUTE_MS;
    const { result } = renderHook(() => useResetCountdown(resetsAt));
    expect(result.current).toBe("3m");
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    expect(result.current).toBe("2m");
  });

  it("useIsFarReset: flips from true to false as a minute tick crosses the one-day boundary", () => {
    vi.useFakeTimers();
    const resetsAt = Date.now() + DAY_MS + 30_000;
    const { result } = renderHook(() => useIsFarReset(resetsAt));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    // Falsification: the compiler memoizes `isFarReset(resetsAt,
    // sampledNowOf())` on `resetsAt` alone, so a regressed build still reads
    // `true` a minute after the real margin dropped under one day.
    expect(result.current).toBe(false);
  });

  // `useMessageTime`'s label is NOT minute-relative like the others above - a
  // day-scoped clock stamp reads the same at :00 and :59 of the same hour, so
  // an ordinary minute tick proves nothing about it. Its one live transition
  // is the day rollover the module doc calls out: "a stamp showing '3:45 PM'
  // has to become 'Sep 10, 3:45 PM' once the day rolls over under a tab left
  // open overnight." That is the tick this cell drives.
  it("useMessageTime: the date prefix appears once a live tick crosses midnight", () => {
    vi.useFakeTimers();
    const justBeforeMidnight = new Date(2026, 3, 23, 23, 59, 30).getTime();
    // Set BEFORE mount: the subscribe-time correction re-renders the first
    // frame from a fresh sample, so the pre-tick read below is the SAME-DAY
    // form deterministically, not whatever a previous cell in this file left
    // the shared minute clock's sample at.
    vi.setSystemTime(justBeforeMidnight);
    const timestamp = justBeforeMidnight;
    const { result } = renderHook(() => useMessageTime(timestamp));
    const sameDayForm = new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    // Same-day form, unambiguously: the label alone, no date prefix - not
    // merely "no comma", which a differently-wrong string could also satisfy.
    expect(result.current).toBe(sameDayForm);
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    const datePrefix = new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    // Falsification: the compiler memoizes `formatMessageTime(timestamp,
    // sampledNowOf())` on `timestamp` alone, so a regressed build still reads
    // `sameDayForm` here instead of the dated cross-midnight form.
    expect(result.current).toBe(`${datePrefix}, ${sameDayForm}`);
  });
});

/**
 * W2-H2: `useRelativeLabel`/`useMessageTime`/`useClockValue` moved the
 * `useSyncExternalStore` snapshot from a raw, always-advancing `now` (every
 * hook here used to render off `sampledNowOf()` directly) to the already
 * COMPUTED label. `useSyncExternalStore` bails a re-render when the new
 * snapshot is `Object.is`-equal to the last one, so once the label text
 * cannot move on a given tick (a settled short-date bucket, a same-day
 * message stamp), that tick must not re-render the leaf at all - the exact
 * per-row cost the header/pane-tab audit measured piling up under Cmd+].
 */
describe("minute-clock label snapshots do not re-render once the text has settled (compiled)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * `vi.spyOn(Intl.DateTimeFormat.prototype, "format", "get")` does not
   * reliably count calls made through a formatter this module already cached
   * before the spy was installed: instrumenting `formatDateTime` directly
   * showed `.format()` genuinely being reached on the tick below while the
   * getter spy stayed at 0 calls - a runtime accessor-caching quirk, not a
   * property of the source under test. A subclass sidesteps that quirk; it
   * needs its own module instance (`vi.resetModules()` + a dynamic import)
   * since `dateTimeFormatters` is a module-level cache and the override must
   * be in place before any formatter is constructed under it.
   *
   * Fake timers installed FIRST, before the `Intl.DateTimeFormat` swap:
   * vitest's fake-`Date` install replaces global `Intl.DateTimeFormat` with
   * its own clock-aware wrapper, and that wrapper's constructor explicitly
   * RETURNS a plain object carrying its own `format` own-property - which
   * shadows a `class ... extends { format() {...} }` override on the
   * prototype (an own property always wins the lookup over a prototype
   * method), so overriding `format` this way is silently dead code if fake
   * timers install AFTER the subclass. Wrapping the format function as an
   * own property assigned from the SUBCLASS'S OWN CONSTRUCTOR - which runs
   * as plain code after `super()` returns, regardless of what `super()`
   * returned - sidesteps that shadowing (confirmed directly against this
   * repo's Bun runtime before writing this fix).
   */
  async function withFormatCallCounter<T>(
    run: (
      relativeTime: typeof import("@/lib/relative-time"),
      getFormatCallCount: () => number,
    ) => T | Promise<T>,
  ): Promise<T> {
    vi.useFakeTimers();
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let formatCallCount = 0;
    class CountingDateTimeFormat extends RealDateTimeFormat {
      constructor(
        localeArg: string | readonly string[] | undefined,
        options: Intl.DateTimeFormatOptions | undefined,
      ) {
        super(localeArg, options);
        const originalFormat = this.format.bind(this);
        this.format = (date: Date | number | undefined): string => {
          formatCallCount += 1;
          return originalFormat(date);
        };
      }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat as typeof Intl.DateTimeFormat;
    vi.resetModules();
    try {
      const relativeTime = await import("@/lib/relative-time");
      return await run(relativeTime, () => formatCallCount);
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
      vi.resetModules();
      vi.useRealTimers();
    }
  }

  it("useRelativeTimestamp: a minute tick does not re-render once the label has settled into the cached short-date bucket", async () => {
    await withFormatCallCounter((relativeTime, getFormatCallCount) => {
      const now = Date.now();
      const createdAt = now - 10 * DAY_MS; // well past the cutoff -> short date
      const renderProbe = vi.fn();
      const { result } = renderHook(() => {
        const label = relativeTime.useRelativeTimestamp(createdAt);
        useLayoutEffect(() => {
          renderProbe();
        });
        return label;
      });
      const expectedDate = new Date(createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      expect(result.current).toBe(expectedDate);
      const baseline = renderProbe.mock.calls.length;
      // Captured AFTER the mount's own format call, so it only counts what
      // the tick below triggers.
      const formatCallsAtBaseline = getFormatCallCount();
      // Sanity: the counter is actually alive (the mount's own render did
      // format at least once) - without this, a broken counter stuck at 0
      // would make every "stays the same" assertion below pass vacuously.
      expect(formatCallsAtBaseline).toBeGreaterThan(0);

      act(() => {
        vi.advanceTimersByTime(MINUTE_MS);
      });
      // Falsification: a snapshot keyed on raw `now` (the pre-fix shape)
      // re-renders on every tick even though a short-date label can never move
      // within the same day.
      expect(renderProbe.mock.calls.length).toBe(baseline);
      // Distinct from the render-count pin above: this proves the cached
      // string is returned WITHOUT re-invoking the expensive Intl formatter,
      // not merely that React happened to bail on an identical result.
      expect(getFormatCallCount()).toBe(formatCallsAtBaseline);
      expect(result.current).toBe(expectedDate);
    });
  });

  it("useMessageTime: a minute tick does not re-render or re-format while the local day is unchanged", async () => {
    await withFormatCallCounter((relativeTime, getFormatCallCount) => {
      const now = new Date(2026, 3, 23, 10, 0, 0).getTime();
      vi.setSystemTime(now);
      const timestamp = now - 5 * MINUTE_MS;
      const renderProbe = vi.fn();
      const { result } = renderHook(() => {
        const label = relativeTime.useMessageTime(timestamp);
        useLayoutEffect(() => {
          renderProbe();
        });
        return label;
      });
      const baseline = renderProbe.mock.calls.length;
      const formatCallsAtBaseline = getFormatCallCount();
      expect(formatCallsAtBaseline).toBeGreaterThan(0);

      act(() => {
        vi.advanceTimersByTime(MINUTE_MS);
      });
      // Falsification: a snapshot keyed on raw `now` re-renders here even
      // though `timestamp` is fixed and the day has not rolled over, so the
      // day-scoped clock stamp cannot have changed.
      expect(renderProbe.mock.calls.length).toBe(baseline);
      // Distinct contract from the render-count pin: proves the cached label
      // is returned without re-running `formatMessageTime`'s Intl call at all.
      expect(getFormatCallCount()).toBe(formatCallsAtBaseline);
      expect(result.current).toBe(
        new Date(timestamp).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    });
  });

  // Control for both cases above: the label DOES still update, and the leaf
  // DOES still re-render, when the tick genuinely changes it - otherwise the
  // "no re-render" pins above would also pass for a hook that never updates
  // at all.
  it("control: still re-renders with a new label once a tick actually crosses a bucket", () => {
    vi.useFakeTimers();
    const createdAt = Date.now();
    const renderProbe = vi.fn();
    const { result } = renderHook(() => {
      const label = useRelativeTimestamp(createdAt);
      useLayoutEffect(() => {
        renderProbe();
      });
      return label;
    });
    expect(result.current).toBe("Just now");
    const baseline = renderProbe.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    expect(result.current).toBe("1m ago");
    expect(renderProbe.mock.calls.length).toBeGreaterThan(baseline);
  });
});

/**
 * W2-H2: every minute-clock hook now gates its subscription on
 * `usePaneVisible()` (`useClockValue`'s `visible && enabled ? clock.subscribe
 * : subscribeIdle`). A hidden pane's leaf must not be woken by a tick it
 * cannot show, and must catch up to the CURRENT label the instant it is
 * revealed - not the stale one it went hidden with, and not one more tick
 * later.
 */
describe("minute-clock hooks unsubscribe while hidden and reveal a fresh label", () => {
  function RelativeTimestampLeaf(props: {
    readonly createdAt: number;
  }): ReactNode {
    const label = useRelativeTimestamp(props.createdAt);
    return <span data-testid="relative-label">{label}</span>;
  }

  function RelativeTimestampProbe(props: {
    readonly createdAt: number;
    readonly visible: boolean;
  }): ReactNode {
    return (
      <PaneVisibilityContext.Provider value={props.visible}>
        <RelativeTimestampLeaf createdAt={props.createdAt} />
      </PaneVisibilityContext.Provider>
    );
  }

  function MessageTimeLeaf(props: { readonly timestamp: number }): ReactNode {
    const label = useMessageTime(props.timestamp);
    return <span data-testid="message-time-label">{label}</span>;
  }

  function MessageTimeProbe(props: {
    readonly timestamp: number;
    readonly visible: boolean;
  }): ReactNode {
    return (
      <PaneVisibilityContext.Provider value={props.visible}>
        <MessageTimeLeaf timestamp={props.timestamp} />
      </PaneVisibilityContext.Provider>
    );
  }

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /**
   * `minuteClock` is a module singleton (see the file-level notes above), and
   * a HIDDEN mount reads its `sampledNow()` directly without ever
   * subscribing to correct it - that is the exact behavior under test. So a
   * hidden mount is the one place in this file where a stale sample left
   * behind by an earlier test (any prior fake-time jump, since nothing
   * resamples the clock while every subscriber is gone) would otherwise leak
   * into this test instead of the module's own "no subscriber" cost. A
   * throwaway visible subscriber forces the same correction `subscribe`
   * would give a real caller, then leaves - the fixture's setup, not the
   * behavior this test pins.
   */
  function warmUpSharedClock(): void {
    const warmup = renderHook(() => useSampledNow());
    warmup.unmount();
  }

  it("useRelativeTimestamp: freezes while hidden and catches up to the real elapsed time on reveal", () => {
    vi.useFakeTimers();
    warmUpSharedClock();
    const mountAt = Date.now();
    const createdAt = mountAt - 30_000; // "Just now"
    const { rerender } = render(
      <RelativeTimestampProbe createdAt={createdAt} visible={false} />,
    );
    expect(screen.getByTestId("relative-label").textContent).toBe("Just now");

    // Five minutes pass while hidden; nothing here is subscribed to observe
    // them. (`advanceTimersByTime` itself moves the fake system clock
    // forward, so this alone reaches `mountAt + 5 * MINUTE_MS`.)
    act(() => {
      vi.advanceTimersByTime(5 * MINUTE_MS);
    });
    expect(screen.getByTestId("relative-label").textContent).toBe("Just now");

    // Reveal: the label must reflect the real elapsed time immediately -
    // "5m ago" (30s + 5m rounds down to 5 whole minutes) - not the stale
    // "Just now" and not a further wait for the next minute tick.
    act(() => {
      rerender(<RelativeTimestampProbe createdAt={createdAt} visible />);
    });
    expect(screen.getByTestId("relative-label").textContent).toBe("5m ago");
  });

  it("useMessageTime: withholds the midnight-rollover date prefix while hidden, and reveals it immediately on becoming visible", () => {
    vi.useFakeTimers();
    const justBeforeMidnight = new Date(2026, 3, 23, 23, 59, 30).getTime();
    vi.setSystemTime(justBeforeMidnight);
    warmUpSharedClock();
    const timestamp = justBeforeMidnight;
    const { rerender } = render(
      <MessageTimeProbe timestamp={timestamp} visible={false} />,
    );
    const sameDayForm = new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(screen.getByTestId("message-time-label").textContent).toBe(
      sameDayForm,
    );

    // Crosses midnight, but hidden - must not flip yet.
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    expect(screen.getByTestId("message-time-label").textContent).toBe(
      sameDayForm,
    );

    act(() => {
      rerender(<MessageTimeProbe timestamp={timestamp} visible />);
    });
    const datePrefix = new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(screen.getByTestId("message-time-label").textContent).toBe(
      `${datePrefix}, ${sameDayForm}`,
    );
  });
});

/**
 * W2-H2: every visibility gate above moved from `usePaneVisible()` alone to
 * `useTileBodyVisible()` (`usePaneVisible() && useTabBodySelected()`). A
 * visible pane whose tab is not the FRONT one must still unsubscribe - the
 * case the tests above cannot see, since they only ever toggle
 * `PaneVisibilityContext` and leave `TabBodySelectedContext` at its
 * default-true. Covers the second-clock (`useGraceCountdown`) and the
 * tick-only (`useSampledNow`) hooks, not just the label hooks above.
 */
describe("minute/second-clock hooks unsubscribe when the tab is unselected in a visible pane", () => {
  function SampledNowLeaf(): ReactNode {
    const now = useSampledNow();
    return <span data-testid="sampled-now">{now}</span>;
  }

  function TabSelectionProbe(props: {
    readonly visible: boolean;
    readonly tabSelected: boolean;
    readonly children: ReactNode;
  }): ReactNode {
    return (
      <PaneVisibilityContext.Provider value={props.visible}>
        <TabBodySelectedContext.Provider value={props.tabSelected}>
          {props.children}
        </TabBodySelectedContext.Provider>
      </PaneVisibilityContext.Provider>
    );
  }

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** Same reasoning as `warmUpSharedClock` above: corrects a stale sample a
   * prior test left on the module-singleton `minuteClock` before this test's
   * own assertions depend on it staying still. */
  function warmUpMinuteClock(): void {
    const warmup = renderHook(() => useSampledNow());
    warmup.unmount();
  }

  it("useSampledNow: freezes while the tab is unselected in a visible pane, and catches up immediately on reselect", () => {
    vi.useFakeTimers();
    warmUpMinuteClock();
    const mountAt = Date.now();
    const { rerender } = render(
      <TabSelectionProbe visible tabSelected={false}>
        <SampledNowLeaf />
      </TabSelectionProbe>,
    );
    expect(screen.getByTestId("sampled-now").textContent).toBe(String(mountAt));

    act(() => {
      vi.advanceTimersByTime(5 * MINUTE_MS);
    });
    // Falsification: a hook still gated on usePaneVisible() alone stays
    // subscribed here, since the pane itself never went hidden - only the
    // tab is unselected.
    expect(screen.getByTestId("sampled-now").textContent).toBe(String(mountAt));

    act(() => {
      rerender(
        <TabSelectionProbe visible tabSelected>
          <SampledNowLeaf />
        </TabSelectionProbe>,
      );
    });
    expect(screen.getByTestId("sampled-now").textContent).toBe(
      String(mountAt + 5 * MINUTE_MS),
    );
  });

  it("useGraceCountdown: keeps counting down while the tab is selected, and freezes as soon as it is not", () => {
    vi.useFakeTimers();
    const now = Date.now();
    function GraceLeaf(): ReactNode {
      const label = useGraceCountdown(now + 5_000);
      return <span data-testid="grace">{label}</span>;
    }
    const { rerender } = render(
      <TabSelectionProbe visible tabSelected>
        <GraceLeaf />
      </TabSelectionProbe>,
    );
    expect(screen.getByTestId("grace").textContent).toBe("5s");

    act(() => {
      rerender(
        <TabSelectionProbe visible tabSelected={false}>
          <GraceLeaf />
        </TabSelectionProbe>,
      );
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // Falsification: a hook still gated on usePaneVisible() alone keeps
    // ticking down here, since the pane itself never went hidden.
    expect(screen.getByTestId("grace").textContent).toBe("5s");
  });
});

const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
};

describe("formatClockTime", () => {
  it("renders a 12-hour time with a day-period designator and no zero-padded hour", () => {
    const at = new Date(2026, 6, 11, 15, 0, 0).getTime();
    const formatted = formatClockTime(at);
    // The old fixtures were `/^\d{1,2}:\d{2} ?[AP]M$/`, `not /^0\d:/` and
    // `/[AP]M/`. `formatClockTime` passes `undefined` as its locale and this
    // file pins none, so all three asserted an ENGLISH render: ja-JP produces
    // "午後3:00" - designator first, no "AM"/"PM", and the leading character
    // is not a digit - and all three went red on a formatter doing exactly
    // what it is documented to do.
    //
    // The equality carries the whole option set, so a source switched to
    // `hour: "2-digit"` ("03:00 PM"), given a weekday, or stripped of
    // `hour12` diverges from this fixture wherever the locale renders the
    // difference at all. Whether the `hour12` half is discriminating depends
    // on the runner's locale - the same limitation the `formatMessageTime`
    // suite below states for its own `hour12` contract.
    expect(formatted).toBe(
      new Date(at).toLocaleTimeString(undefined, CLOCK_OPTIONS),
    );
    // Anchored independently of that equality, which survives the source and
    // this fixture drifting together. Without `hour12: true` a 24-hour-default
    // locale renders "15:00" and carries no day period at all - the exact
    // ambiguity the resume-time card exists to remove.
    expect(formatted).toContain(dateTimePart(at, CLOCK_OPTIONS, "dayPeriod"));
    // 15:00 renders as the 12-hour hour, unpadded. Compared against the
    // locale's own hour token so this survives a non-Latin numbering system,
    // where a literal "3" appears nowhere in a correct render.
    expect(formatted).toContain(dateTimePart(at, CLOCK_OPTIONS, "hour"));
  });
});

// The cap a fallback wait can name went to seven days
// (`FALLBACK_POLICY_LIMITS.maxWaitMinutes`), and a card naming a time that far
// out with no weekday states the wrong day - the reason this exists rather
// than every wait surface calling `formatClockTime` directly.
describe("formatWaitTime", () => {
  const now = Date.parse("2026-04-23T12:00:00.000Z");

  it("renders the bare clock time for a moment under a day away", () => {
    expect(formatWaitTime(now + 23 * HOUR_MS, now)).toBe(
      formatClockTime(now + 23 * HOUR_MS),
    );
  });

  it("renders the weekday-qualified form at exactly a day away, and beyond", () => {
    // Falsification: `formatWaitTime` always returning `formatClockTime(at)` -
    // both of these still equal the bare clock time instead.
    expect(formatWaitTime(now + DAY_MS, now)).toBe(
      formatResetDateTime(now + DAY_MS),
    );
    expect(formatWaitTime(now + 4 * DAY_MS, now)).toBe(
      formatResetDateTime(now + 4 * DAY_MS),
    );
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

// A mounted subscriber whose INPUT changed - not its
// subscription - used to render against the last interval fire's sample,
// up to one interval old, until the next fire. `resample()` is the
// corrective the caller reaches for on that path (see `useGraceCountdown`'s
// `useLayoutEffect`), so it is tested directly here, the same way
// `subscribe`'s own re-sampling is tested above.
describe("createSharedClock resample", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies once on a forward move and leaves an already-current sample alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clock = createSharedClock(1_000);
    let calls = 0;
    const stop = clock.subscribe(() => {
      calls += 1;
    });
    calls = 0; // discard subscribe's own immediate correction

    // Same millisecond as the last sample: nothing moved, so `resample`
    // must not notify - `>` rather than `!==`, mirrored from `subscribe`'s
    // own guard.
    clock.resample();
    expect(calls).toBe(0);
    expect(clock.getSnapshot()).toBe(0);

    vi.setSystemTime(BASE + 400);
    clock.resample();
    // Falsification: delete `notifyListeners()` from `resample` (stores the
    // new sample but never wakes a subscriber already rendered against the
    // old one) - `calls` stays 0 here even though the two assertions below
    // still pass, since `sampledNow`/`getSnapshot` read the store directly.
    expect(calls).toBe(1);
    expect(clock.sampledNow()).toBe(BASE + 400);
    expect(clock.getSnapshot()).toBe(1);

    // A second forward move notifies again - not a one-shot latch.
    vi.setSystemTime(BASE + 900);
    clock.resample();
    expect(calls).toBe(2);
    expect(clock.sampledNow()).toBe(BASE + 900);
    expect(clock.getSnapshot()).toBe(2);

    stop();
  });

  it("does not notify or move the sample on a backward system-clock jump", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 900);
    const clock = createSharedClock(1_000);
    let calls = 0;
    const stop = clock.subscribe(() => {
      calls += 1;
    });
    calls = 0;
    const snapshotBefore = clock.getSnapshot();

    // The clock jumps backward - a system-clock correction, not a tick.
    vi.setSystemTime(BASE);
    clock.resample();
    // Falsification: drop the `now <= sampledNow` guard (or weaken it to
    // `now < sampledNow`, which still fires on an EQUAL sample) - the sample
    // rewinds to `BASE`, the snapshot bumps, and every mounted subscriber is
    // woken to re-render a countdown that just moved backward.
    expect(calls).toBe(0);
    expect(clock.sampledNow()).toBe(BASE + 900);
    expect(clock.getSnapshot()).toBe(snapshotBefore);

    stop();
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

// `vitest.config.ts` pins neither `TZ` nor a locale, so every case below is
// built from `new Date(year, month, day, hour, minute, second)` - local
// calendar fields, interpreted in whatever zone the runner happens to use -
// rather than a fixed UTC ISO string. That keeps a case deterministic without
// needing to know or pin the zone: the day-boundary comparison inside
// `formatMessageTime` reads the same local fields the fixture was built from,
// so the two agree in any timezone. Expected strings are derived from
// `toLocaleTimeString`/`toLocaleDateString` with the exact options the source
// uses (no `hour12`), never a hard-coded literal like "3:45 PM" - that passes
// on this machine and fails in CI under a different locale.
describe("formatMessageTime", () => {
  it("renders the time alone when the timestamp is on the same local day as `now`", () => {
    const now = new Date(2026, 3, 23, 14, 30, 0).getTime();
    const createdAt = new Date(2026, 3, 23, 9, 15, 0).getTime();
    const expected = new Date(createdAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const result = formatMessageTime(createdAt, now);
    expect(result).toBe(expected);
    // Structural guard: a date-prefixed render always joins with ", ", so an
    // un-prefixed render must not contain one.
    expect(result).not.toContain(",");
  });

  // The trap the day rule exists for: two instants only two hours apart, but
  // 11pm and 1am are different CALENDAR days. A `< 24h` delta would call this
  // "recent enough" and wrongly omit the date.
  it("prefixes a short date for two instants only two hours apart that straddle local midnight", () => {
    const yesterdayLate = new Date(2026, 3, 22, 23, 0, 0).getTime();
    const todayEarly = new Date(2026, 3, 23, 1, 0, 0).getTime();

    const result = formatMessageTime(yesterdayLate, todayEarly);

    const expectedDate = new Date(yesterdayLate).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const expectedTime = new Date(yesterdayLate).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(result).toBe(`${expectedDate}, ${expectedTime}`);
  });

  // The mirror case: a ~23h gap that a `< 24h` delta would call "yesterday",
  // but both instants fall on the same calendar day, so no date is added.
  it("omits the date prefix for a ~23h-old instant that is still the same calendar day", () => {
    const createdAt = new Date(2026, 3, 23, 0, 30, 0).getTime();
    const now = new Date(2026, 3, 23, 23, 30, 0).getTime();

    const result = formatMessageTime(createdAt, now);

    const expectedTime = new Date(createdAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(result).toBe(expectedTime);
    expect(result).not.toContain(",");
  });

  // Documents the "locale decides 12h/24h" contract directly: unlike
  // `formatResetDateTime` (which hard-codes `hour12: true`), this formatter
  // passes no `hour12` at all, so its output must match the locale's own
  // default rendering rather than a forced 12-hour one. Whether this actually
  // differs from a `hour12: true` render depends on the runner's locale (most
  // CI locales default to 12-hour), so the discriminating half of this
  // contract cannot be asserted without pinning a 24-hour locale - this
  // documents the intent and would catch a `hour12: true` regression under
  // any 24-hour-default locale.
  it("passes no explicit hour12 option, unlike formatResetDateTime", () => {
    const now = new Date(2026, 3, 23, 15, 45, 0).getTime();
    const expected = new Date(now).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(formatMessageTime(now, now)).toBe(expected);
  });
});

describe("formatMessageTimeWithSeconds", () => {
  it("carries seconds on a same-day render", () => {
    const now = new Date(2026, 3, 23, 14, 30, 0).getTime();
    const createdAt = new Date(2026, 3, 23, 14, 25, 42).getTime();

    const result = formatMessageTimeWithSeconds(createdAt, now);

    const expected = new Date(createdAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    expect(result).toBe(expected);
    expect(result).not.toContain(",");
  });

  it("follows the same day-scoping rule as formatMessageTime, seconds included", () => {
    const now = new Date(2026, 3, 23, 10, 0, 0).getTime();
    const createdAt = new Date(2026, 3, 20, 10, 0, 5).getTime();

    const result = formatMessageTimeWithSeconds(createdAt, now);

    const expectedDate = new Date(createdAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const expectedTime = new Date(createdAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    expect(result).toBe(`${expectedDate}, ${expectedTime}`);
  });
});

describe("formatFullTimestamp", () => {
  it("restores the weekday, year and seconds that formatMessageTime drops", () => {
    const timestamp = new Date(2026, 3, 23, 15, 45, 12).getTime();

    const result = formatFullTimestamp(timestamp);

    const options: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    };
    const expected = new Date(timestamp).toLocaleString(undefined, options);
    expect(result).toBe(expected);
    // The equality above still passes if the source and this fixture ever
    // drift to the same wrong options, so anchor the year independently - it
    // is the part this format exists to restore. It has to be read out of the
    // formatter rather than written as "2026": per the note above the suite,
    // no locale is pinned, and under one with non-Latin digits (ar-EG) or a
    // non-Gregorian calendar (th-TH renders the Buddhist year 2569) the ASCII
    // Gregorian year appears nowhere in `result`.
    const yearPart = new Intl.DateTimeFormat(undefined, options)
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === "year");
    if (yearPart === undefined) {
      throw new Error("the full format produced no year part to anchor on");
    }
    expect(result).toContain(yearPart.value);
    // A day-scoped, same-day render of the same instant never carries a year
    // - this is the "unabridged" form that restores it unconditionally.
    expect(result).not.toBe(formatMessageTime(timestamp, timestamp));
  });
});

/**
 * W3-I1: every locale call site (`formatClockTime`, `formatResetDateTime`,
 * `formatFullTimestamp`, `formatResetFullDateTime`) moved from a direct
 * `Date.prototype.toLocale*` call to the module-level `formatDateTime`
 * helper, which resolves a cached `Intl.DateTimeFormat` from a
 * `[locale, options]` key and calls `.format()` on it. Output must be
 * byte-identical to what the old `Date.prototype.toLocale*` calls produced -
 * the point of the change is where the formatting work happens, not what it
 * renders.
 *
 * The app pins no locale anywhere (every call site passes `undefined`), so
 * there is no production seam to vary the locale through. `withForcedLocale`
 * substitutes a real locale for `undefined` at the `Intl.DateTimeFormat`
 * constructor itself - the only place `formatDateTime` ever resolves one -
 * and reimports the module fresh per locale, since `dateTimeFormatters` is a
 * module-level cache keyed on the LITERAL `undefined` every call site passes;
 * without a fresh module the second locale's formatters would hit the first
 * locale's cached entries.
 */
describe("formatDateTime: locale/date matrix against native Date locale methods", () => {
  const TIMESTAMPS = [
    Date.parse("2026-07-11T10:35:00.000Z"),
    Date.parse("2026-01-01T00:00:00.000Z"), // year boundary
    Date.parse("2026-12-31T23:59:00.000Z"), // year boundary, other edge
  ];
  const LOCALES = ["en-US", "en-GB", "fr-FR", "ar-EG", "ja-JP"];

  const RESET_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
    weekday: "short",
  };
  const RESET_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  const FULL_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  };
  const RESET_FULL_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };

  async function withForcedLocale<T>(
    locale: string,
    run: (relativeTime: typeof import("@/lib/relative-time")) => T,
  ): Promise<T> {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    class ForcedLocaleDateTimeFormat extends RealDateTimeFormat {
      constructor(
        localeArg: string | readonly string[] | undefined,
        options: Intl.DateTimeFormatOptions | undefined,
      ) {
        super(localeArg ?? locale, options);
      }
    }
    Intl.DateTimeFormat =
      ForcedLocaleDateTimeFormat as typeof Intl.DateTimeFormat;
    vi.resetModules();
    try {
      const relativeTime = await import("@/lib/relative-time");
      return run(relativeTime);
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
      vi.resetModules();
    }
  }

  it("matches native Date locale methods for every locale and timestamp sampled", async () => {
    for (const locale of LOCALES) {
      await withForcedLocale(locale, (relativeTime) => {
        for (const timestamp of TIMESTAMPS) {
          const date = new Date(timestamp);
          expect(relativeTime.formatClockTime(timestamp)).toBe(
            date.toLocaleTimeString(locale, RESET_TIME_OPTIONS),
          );
          expect(relativeTime.formatResetDateTime(timestamp)).toBe(
            `${date.toLocaleDateString(locale, RESET_DATE_OPTIONS)} ${date.toLocaleTimeString(locale, RESET_TIME_OPTIONS)}`,
          );
          expect(relativeTime.formatFullTimestamp(timestamp)).toBe(
            date.toLocaleString(locale, FULL_TIMESTAMP_OPTIONS),
          );
          expect(relativeTime.formatResetFullDateTime(timestamp)).toBe(
            date.toLocaleString(locale, RESET_FULL_DATE_TIME_OPTIONS),
          );
        }
      });
    }
  });
});

/**
 * W3-I1's whole point: one `Intl.DateTimeFormat` construction per distinct
 * `[locale, options]` key, reused across every timestamp AND every call site
 * that happens to want the same options - not one construction per call.
 * `formatClockTime` and the time half of `formatResetDateTime` pass the
 * exact same option shape (`{hour: "numeric", minute: "2-digit",
 * hour12: true}`), so they must share the one cached instance.
 */
describe("formatDateTime: cached Intl.DateTimeFormat construction (module-level, per key)", () => {
  it("constructs a formatter once per key, reused across many timestamps and across call sites sharing options", async () => {
    // `vi.spyOn` cannot wrap a native class constructor and still produce a
    // working instance (a plain `.apply()` call-through does not satisfy
    // `Intl.DateTimeFormat`'s `[[Construct]]` semantics), so this counts
    // constructions through a real subclass instead - the same technique
    // `withForcedLocale` above uses.
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let constructCount = 0;
    class CountingDateTimeFormat extends RealDateTimeFormat {
      constructor(
        localeArg: string | readonly string[] | undefined,
        options: Intl.DateTimeFormatOptions | undefined,
      ) {
        super(localeArg, options);
        constructCount += 1;
      }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat as typeof Intl.DateTimeFormat;
    vi.resetModules();
    try {
      const relativeTime = await import("@/lib/relative-time");
      const timestamps = [
        Date.parse("2026-01-05T08:00:00.000Z"),
        Date.parse("2026-03-14T15:30:00.000Z"),
        Date.parse("2026-11-22T21:45:00.000Z"),
      ];

      for (const timestamp of timestamps) {
        relativeTime.formatClockTime(timestamp);
      }
      // `formatResetDateTime`'s time-of-day half shares `formatClockTime`'s
      // exact options - no new construction for it, only for its distinct
      // weekday-only half.
      for (const timestamp of timestamps) {
        relativeTime.formatResetDateTime(timestamp);
      }

      // Falsification: key the cache on locale alone (drop `options` from
      // the key), or on the timestamp, and this count rises past 3 - one
      // construction per `formatClockTime` call, or per distinct call site,
      // instead of one per distinct option shape.
      //
      // W3-I1: 3, not 2 - the first `formatDateTime` call's once-per-second
      // zone probe (empty-options `new Intl.DateTimeFormat()`) adds a third,
      // separate from the two option-bearing constructions this test pins.
      expect(constructCount).toBe(3);
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
      vi.resetModules();
    }
  });
});

/**
 * W3-I1: an OS timezone change has to reach a cache that was warmed BEFORE
 * the change, and it has to reach it on the ONE persistent module instance a
 * real session keeps - not only on a freshly imported one. Every other
 * `Intl.DateTimeFormat`/timezone test in this file uses `vi.resetModules()`
 * for isolation; this suite deliberately does not, using the file's own
 * top-level imports instead, since a fix that only works on a cold module
 * would still pass every one of those.
 *
 * `process.env.TZ` is a real, process-wide switch: reassigning it changes
 * what `Date.prototype.getTimezoneOffset()` and
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` report for every
 * subsequent call - but NOT what an `Intl.DateTimeFormat` instance already
 * constructed under the OLD zone renders: that instance keeps the old zone
 * baked in and never updates (confirmed directly against this repo's Bun
 * runtime before writing this suite). That staleness is exactly what
 * `dateTimeFormatters.clear()` exists to correct, by forcing the next call to
 * construct a fresh instance instead of reusing the stale one.
 */
describe("W3-I1: an in-process OS timezone change reaches a warmed cache", () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    cleanup();
    process.env.TZ = ORIGINAL_TZ;
    vi.useRealTimers();
  });

  it("recomputes to fresh native output for timestamps whose own offset moved, and stays correct for one whose offset did not", () => {
    vi.useFakeTimers();
    process.env.TZ = "Europe/Berlin";

    // "Now" is January, where Berlin and Lagos share the same offset - so the
    // viewing instant's own local-midnight key stays IDENTICAL across the
    // zone flip below, isolating the generation/offset check as the only
    // thing that can be driving a recompute (not an incidental day change).
    const now0 = Date.UTC(2026, 0, 15, 12, 0, 0);
    // Berlin (CEST, UTC+2 in July) vs Lagos (UTC+1 year-round): identical
    // Jan-1 offset, different Jul-1 offset - the CHEAP current-year check
    // alone catches this swap, no need to wait on the throttled zone probe.
    const oldRelativeCreatedAt = Date.UTC(2025, 6, 5, 22, 30, 0); // Jul 6 00:30 Berlin / Jul 5 23:30 Lagos
    const janMessage = Date.UTC(2026, 0, 10, 9, 0, 0); // 10:00 AM in both zones - offset never moves
    const julMessage = Date.UTC(2025, 6, 10, 9, 0, 0); // 11:00 AM Berlin / 10:00 AM Lagos - offset moves
    vi.setSystemTime(now0);

    const oldRelative = renderHook(() =>
      useRelativeTimestamp(oldRelativeCreatedAt),
    );
    const janLabel = renderHook(() => useMessageTime(janMessage));
    const julLabel = renderHook(() => useMessageTime(julMessage));

    const expectedMessage = (timestamp: number): string =>
      `${new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    const expectedShortDate = (timestamp: number): string =>
      new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });

    // Warm cache: the initial render under Berlin already matches a fresh
    // native call - this is not a cold, empty-cache case.
    expect(oldRelative.result.current).toBe(
      expectedShortDate(oldRelativeCreatedAt),
    );
    expect(julLabel.result.current).toBe(expectedMessage(julMessage));
    expect(janLabel.result.current).toBe(expectedMessage(janMessage));

    process.env.TZ = "Africa/Lagos";
    // >=1s later, and also the shared clock's own minute tick - what
    // actually wakes these subscribed leaves to re-check their cache.
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });

    // The short-date bucket picks up the changed local calendar date.
    expect(oldRelative.result.current).toBe(
      expectedShortDate(oldRelativeCreatedAt),
    );
    // Falsification: dropping the per-timestamp `offset` check and relying on
    // `generation` alone would still pass this one (the global generation
    // moved too) - `julMessage`'s own offset moving is what this pins.
    expect(julLabel.result.current).toBe(expectedMessage(julMessage));
    // `janMessage`'s own offset is identical in both zones. Its label must
    // still read correctly here - not merely "unchanged", which a fully
    // stale cache would also satisfy by coincidence in this one case.
    expect(janLabel.result.current).toBe(expectedMessage(janMessage));
    // A plain (non-hook) call site sharing the same module-level formatter
    // cache also reflects the new zone.
    expect(formatClockTime(julMessage)).toBe(
      new Date(julMessage).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
    );

    oldRelative.unmount();
    janLabel.unmount();
    julLabel.unmount();
  });
});

/**
 * W3-I1: Africa/Abidjan and America/Danmarkshavn render identical Jan-1 and
 * Jul-1 offsets for the current year (both 0 - neither observes DST), so the
 * cheap seasonal-offset check cannot distinguish them. Danmarkshavn was
 * GMT-2 as recently as 1990, a real historical divergence that lives in the
 * zone's IDENTITY rather than its current offset pair - exactly the case
 * `getFormattingGeneration`'s once-per-second `resolvedOptions().timeZone`
 * probe exists to catch, at the accepted cost of up to ~1s of stale
 * formatting while the throttle holds.
 */
describe("W3-I1: a same-offset zone identity change is caught by the throttled zone-name probe", () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
    vi.useRealTimers();
    vi.resetModules();
  });

  it("keeps a stale historical rendering within the probe's throttle window, then corrects once it elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
    process.env.TZ = "Africa/Abidjan";
    vi.resetModules();
    const relativeTime = await import("@/lib/relative-time");

    const historicalAt = Date.UTC(1990, 6, 1, 12, 0, 0);
    const nativeUnderCurrentTz = (): string =>
      new Date(historicalAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

    const abidjanLabel = relativeTime.formatClockTime(historicalAt);
    expect(abidjanLabel).toBe(nativeUnderCurrentTz());

    process.env.TZ = "America/Danmarkshavn";
    // Falsification: an unthrottled probe (a fresh `resolvedOptions().
    // timeZone` read on every `formatDateTime` call) would already read the
    // new zone here - this pins the ACCEPTED throttle window, not merely
    // that a fix eventually lands.
    expect(relativeTime.formatClockTime(historicalAt)).toBe(abidjanLabel);

    vi.advanceTimersByTime(1_000);
    const correctedLabel = relativeTime.formatClockTime(historicalAt);
    expect(correctedLabel).toBe(nativeUnderCurrentTz());
    // Falsification: relying on the cheap Jan/Jul offset check alone (no
    // zone-name probe at all) leaves this equal to the stale label forever,
    // since Abidjan and Danmarkshavn share identical current-year offsets.
    expect(correctedLabel).not.toBe(abidjanLabel);
  });
});

/**
 * W3-I1: the zone-name probe is throttled to at most once per elapsed
 * second, regardless of how many `formatDateTime` calls land inside that
 * second - distinct from the option-bearing formatter cache, which never
 * reconstructs once a key is built.
 *
 * `Date.now` stubbed directly (`vi.spyOn`), not `vi.useFakeTimers()`:
 * vitest's fake-`Date` install also replaces global `Intl.DateTimeFormat`
 * with its own clock-aware wrapper (mirrors the real constructor's own
 * `format`/`resolvedOptions` on a plain returned object, not a subclass),
 * which defeats construction-counting via `extends` the way this file's
 * other counting suites rely on. Stubbing only `Date.now` - the one call
 * `getFormattingGeneration` makes to read "now" - crosses the probe's
 * throttle window instantly, with no real wait and no fake-Date/Intl
 * interaction: the `Date` constructor and `Intl.DateTimeFormat` stay real.
 */
describe("W3-I1: the zone-name probe stays bounded to about once per second, not once per format call", () => {
  it("keeps option-bearing formatter construction fixed while probe construction advances only across an elapsed second", async () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let optionConstructCount = 0;
    let probeConstructCount = 0;
    class CountingDateTimeFormat extends RealDateTimeFormat {
      constructor(
        localeArg: string | readonly string[] | undefined,
        options: Intl.DateTimeFormatOptions | undefined,
      ) {
        super(localeArg, options);
        if (options === undefined) {
          probeConstructCount += 1;
        } else {
          optionConstructCount += 1;
        }
      }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat as typeof Intl.DateTimeFormat;
    const fixedStart = Date.parse("2026-03-14T15:30:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedStart);
    vi.resetModules();
    try {
      const relativeTime = await import("@/lib/relative-time");
      const timestamp = fixedStart;

      for (let call = 0; call < 5; call += 1) {
        relativeTime.formatClockTime(timestamp);
        relativeTime.formatResetDateTime(timestamp);
      }
      // Falsification: probing on every `formatDateTime` entry instead of
      // once per elapsed second makes this grow with the 10 calls above
      // instead of staying at the one probe this first window allows.
      expect(probeConstructCount).toBe(1);
      expect(optionConstructCount).toBe(2);

      nowSpy.mockReturnValue(fixedStart + 1_000);

      for (let call = 0; call < 5; call += 1) {
        relativeTime.formatClockTime(timestamp);
        relativeTime.formatResetDateTime(timestamp);
      }
      // One more probe for the elapsed second, still bounded regardless of
      // how many calls landed inside either window.
      expect(probeConstructCount).toBe(2);
      // The cached, option-bearing formatters never reconstruct once built -
      // one for `formatClockTime`'s options, one for `formatResetDateTime`'s
      // distinct weekday-only half - across either window.
      expect(optionConstructCount).toBe(2);
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
      vi.resetModules();
      nowSpy.mockRestore();
    }
  });
});

/**
 * W3-I1: `formatDateTime` checks `Number.isNaN` and returns the literal
 * "Invalid Date" before ever calling `Intl.DateTimeFormat.prototype.format`,
 * which throws a RangeError on an invalid date - unlike the
 * `Date.prototype.toLocale*` methods it replaced, which returned that same
 * literal without throwing.
 */
describe("formatDateTime: invalid timestamps degrade to the literal 'Invalid Date' instead of throwing", () => {
  const INVALID = NaN;

  it("every locale-formatting call site returns 'Invalid Date' rather than throwing", () => {
    expect(() => formatClockTime(INVALID)).not.toThrow();
    expect(formatClockTime(INVALID)).toBe("Invalid Date");

    expect(formatFullTimestamp(INVALID)).toBe("Invalid Date");
    expect(formatResetFullDateTime(INVALID)).toBe("Invalid Date");

    // Composes two formatDateTime calls with a space joiner; both halves
    // degrade independently.
    expect(formatResetDateTime(INVALID)).toBe("Invalid Date Invalid Date");

    // `isSameLocalDay(NaN, now)` is false (NaN !== any real year), so
    // formatMessageTime falls into its date-prefixed branch and both halves
    // - the short date and the time - degrade too.
    const now = Date.parse("2026-04-23T12:00:00.000Z");
    expect(formatMessageTime(INVALID, now)).toBe("Invalid Date, Invalid Date");
  });
});
