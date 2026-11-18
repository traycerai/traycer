import { describe, expect, it } from "vitest";
import { temporalGroupForTimestamp } from "@/lib/notifications/notification-temporal-group";

/** Local-calendar midnight for the day containing `timestamp`. */
function localMidnight(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

describe("temporalGroupForTimestamp", () => {
  // Construct entirely in local wall-clock so calendar-day math is stable
  // across timezones (UTC helpers would shift local midnight).
  const now = new Date(2024, 5, 15, 15, 0, 0).getTime();
  const todayStart = localMidnight(now);
  const yesterdayStart = todayStart - 86_400_000;
  const twoDaysAgoStart = todayStart - 2 * 86_400_000;

  it("returns today for timestamps on the current local calendar day", () => {
    expect(temporalGroupForTimestamp(todayStart, now)).toBe("today");
    expect(temporalGroupForTimestamp(todayStart + 60_000, now)).toBe("today");
    expect(temporalGroupForTimestamp(now, now)).toBe("today");
  });

  it("returns yesterday for the previous local calendar day", () => {
    expect(temporalGroupForTimestamp(yesterdayStart, now)).toBe("yesterday");
    expect(
      temporalGroupForTimestamp(yesterdayStart + 12 * 3_600_000, now),
    ).toBe("yesterday");
  });

  it("returns earlier for two or more local calendar days ago", () => {
    expect(temporalGroupForTimestamp(twoDaysAgoStart, now)).toBe("earlier");
    expect(temporalGroupForTimestamp(twoDaysAgoStart - 86_400_000, now)).toBe(
      "earlier",
    );
  });

  it("splits at local midnight, not elapsed 24h duration", () => {
    // 11:59pm yesterday and 12:01am today are ~2 minutes apart but live in
    // opposite calendar-day buckets. A naive "24h elapsed" check would put
    // both in "today" relative to a mid-afternoon `now`.
    const almostMidnightYesterday = todayStart - 60_000; // 23:59 previous day
    const justAfterMidnightToday = todayStart + 60_000; // 00:01 today

    expect(temporalGroupForTimestamp(almostMidnightYesterday, now)).toBe(
      "yesterday",
    );
    expect(temporalGroupForTimestamp(justAfterMidnightToday, now)).toBe(
      "today",
    );

    // And ~2 minutes of wall-clock elapsed between them.
    expect(justAfterMidnightToday - almostMidnightYesterday).toBe(120_000);
  });

  it("treats a future timestamp on a later day as today (dayDelta <= 0)", () => {
    const tomorrowAfternoon = todayStart + 86_400_000 + 3_600_000;
    expect(temporalGroupForTimestamp(tomorrowAfternoon, now)).toBe("today");
  });

  it("classifies just-under-24h-ago timestamps by calendar day, not elapsed time", () => {
    // At 15:00 local "now", a timestamp from 15:30 yesterday is < 24h old, but
    // it belongs to yesterday's calendar day. A duration-based implementation
    // that only checks `now - timestamp < DAY_MS` would incorrectly return
    // "today".
    const afternoonYesterday = yesterdayStart + 15 * 3_600_000 + 30 * 60_000;
    expect(now - afternoonYesterday).toBeLessThan(86_400_000);
    expect(temporalGroupForTimestamp(afternoonYesterday, now)).toBe(
      "yesterday",
    );
  });
});
