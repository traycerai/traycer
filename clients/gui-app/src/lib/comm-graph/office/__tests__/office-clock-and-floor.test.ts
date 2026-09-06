import { describe, expect, it } from "vitest";
import { officeClockAngles } from "@/lib/comm-graph/office/office-clock";
import { officeFloorName } from "@/lib/comm-graph/office/office-floor-name";

/** A local-time instant, built so the assertions do not depend on the zone. */
function at(hours: number, minutes: number): number {
  return new Date(2026, 8, 2, hours, minutes, 0, 0).getTime();
}

const QUARTER = Math.PI / 2;

/**
 * The hands are the one part of the wall clock that can be subtly wrong and
 * still draw: a quarter-turn out, or an hour hand that snaps between hours
 * instead of creeping. A test that only asserted "nothing threw" would pass
 * through every one of those.
 */
describe("officeClockAngles", () => {
  it("puts twelve o'clock at zero", () => {
    expect(officeClockAngles(at(12, 0)).hour).toBeCloseTo(0);
    expect(officeClockAngles(at(12, 0)).minute).toBeCloseTo(0);
  });

  it("puts three o'clock a quarter turn clockwise", () => {
    expect(officeClockAngles(at(3, 0)).hour).toBeCloseTo(QUARTER);
  });

  it("puts half past on the minute hand's half turn", () => {
    expect(officeClockAngles(at(1, 30)).minute).toBeCloseTo(Math.PI);
  });

  it("creeps the hour hand with the minutes rather than snapping", () => {
    const onTheHour = officeClockAngles(at(1, 0)).hour;
    const halfPast = officeClockAngles(at(1, 30)).hour;
    // Half an hour on is half of one hour-step further round, not zero and not
    // a whole step.
    expect(halfPast - onTheHour).toBeCloseTo(Math.PI / 12);
  });

  it("reads afternoon hours on the twelve-hour face", () => {
    expect(officeClockAngles(at(15, 0)).hour).toBeCloseTo(
      officeClockAngles(at(3, 0)).hour,
    );
  });
});

describe("officeFloorName", () => {
  it("prefers the host's own display name", () => {
    const names = new Map([["host-a", "Pranshu's MacBook"]]);
    expect(officeFloorName("host-a", names)).toBe("Pranshu's MacBook");
  });

  it("falls back to a SHORT id when the directory has not answered", () => {
    const full = "0123456789abcdef";
    const short = officeFloorName(full, new Map());
    expect(short).toBe("01234567");
    // The sign is two tiles wide; a full opaque id would not fit and would not
    // tell anyone anything either.
    expect(short.length).toBeLessThan(full.length);
  });

  it("treats an empty display name as no name at all", () => {
    expect(officeFloorName("0123456789", new Map([["0123456789", ""]]))).toBe(
      "01234567",
    );
  });

  it("says so when a record predates host binding", () => {
    expect(officeFloorName(null, new Map())).toBe("Unattributed");
  });
});
