/**
 * Clock-hand geometry, in radians clockwise from twelve.
 *
 * Pure and separate from the drawing so it can be checked: the hands are the
 * one part of the wall clock that can be subtly wrong - an hour hand that
 * jumps between hours instead of creeping, or a minute hand a quarter-turn
 * out - and none of that is visible to a test that only asserts nothing threw.
 */
export interface OfficeClockAngles {
  readonly hour: number;
  readonly minute: number;
}

const RADIANS_PER_HOUR = Math.PI / 6;
const RADIANS_PER_MINUTE = Math.PI / 30;

export function officeClockAngles(timeMs: number): OfficeClockAngles {
  const at = new Date(timeMs);
  const minutes = at.getMinutes();
  return {
    // The hour hand carries the minutes, so it sits BETWEEN hours rather than
    // snapping across them on the hour.
    hour: ((at.getHours() % 12) + minutes / 60) * RADIANS_PER_HOUR,
    minute: minutes * RADIANS_PER_MINUTE,
  };
}
