import { describe, expect, it } from "vitest";
import { formatRelativeTimestamp } from "@/lib/relative-time";

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
