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

  it("covers every local date across a spring-forward boundary", () => {
    // 2026-03-08 is the US spring-forward date (a 23h local day). A 24h
    // stride can step straight over a date here, dropping a column whose
    // usage still counts toward the totals.
    const days = lastNCalendarDays(
      10,
      "America/New_York",
      Date.parse("2026-03-10T12:00:00Z"),
    );
    expect(days).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });

  it("covers every local date across a fall-back boundary", () => {
    // 2026-11-01 is the US fall-back date (a 25h local day). A 24h stride
    // maps two samples onto the same date here, so the axis used to come
    // back one column SHORT - silently dropping its oldest day.
    const days = lastNCalendarDays(
      10,
      "America/New_York",
      Date.parse("2026-11-05T04:30:00Z"),
    );
    expect(days).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
  });

  it("degrades to UTC rather than throwing on a zone the runtime does not know", () => {
    // The response's `timezone` is only length-checked on the wire; an
    // unknown name must not take the chart's whole render down.
    expect(lastNCalendarDays(1, "Not/AZone", FIXED_NOW_MS)).toEqual([
      "2026-08-09",
    ]);
  });
});
