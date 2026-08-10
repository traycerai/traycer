import { describe, expect, it } from "vitest";
import { lastNCalendarDays } from "@/lib/usage-analytics/day-window";

// A fixed instant well clear of any DST boundary in the zones exercised
// below, so the test is not incidentally sensitive to when it runs.
const FIXED_NOW_MS = Date.parse("2026-08-09T12:00:00Z");

describe("lastNCalendarDays", () => {
  it("returns exactly windowDays entries, oldest first, ending on today", () => {
    const days = lastNCalendarDays(7, "UTC", FIXED_NOW_MS);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-08-03");
    expect(days.at(-1)).toBe("2026-08-09");
  });

  it("produces YYYY-MM-DD strings in ascending order", () => {
    const days = lastNCalendarDays(30, "UTC", FIXED_NOW_MS);
    const sorted = [...days].sort();
    expect(days).toEqual(sorted);
  });

  it("resolves through the given IANA zone, not the runtime's local zone", () => {
    // At 2026-08-09T05:00:00Z, Tokyo (UTC+9) has already turned over to the
    // 9th (14:00 local); American Samoa (UTC-11) is still on the 8th (18:00
    // the previous day). Same instant, different last day.
    const nowMs = Date.parse("2026-08-09T05:00:00Z");
    const tokyo = lastNCalendarDays(1, "Asia/Tokyo", nowMs);
    const samoa = lastNCalendarDays(1, "Pacific/Pago_Pago", nowMs);
    expect(tokyo).toEqual(["2026-08-09"]);
    expect(samoa).toEqual(["2026-08-08"]);
  });

  it("never returns more entries than requested, even across a DST boundary", () => {
    // 2026-03-08 is a US DST spring-forward date - a naive 24h-stride walk
    // risks a duplicate/skewed day here; deduping keeps the count honest.
    const days = lastNCalendarDays(
      10,
      "America/New_York",
      Date.parse("2026-03-10T12:00:00Z"),
    );
    expect(days.length).toBeLessThanOrEqual(10);
    expect(new Set(days).size).toBe(days.length);
  });
});
