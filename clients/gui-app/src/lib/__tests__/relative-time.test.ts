import { describe, expect, it } from "vitest";
import {
  formatRelativeTimestamp,
  formatResetCountdown,
  formatResetDateTime,
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
});
