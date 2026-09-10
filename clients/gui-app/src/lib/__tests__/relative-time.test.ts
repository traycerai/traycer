import { describe, expect, it } from "vitest";
import {
  formatFullTimestamp,
  formatMessageTime,
  formatMessageTimeWithSeconds,
  formatRelativeTimestamp,
  formatResetCountdown,
  formatResetDateTime,
  formatResetFullDateTime,
  isFarReset,
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
