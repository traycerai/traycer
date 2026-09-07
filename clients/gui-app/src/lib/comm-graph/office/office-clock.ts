/** Clock-hand geometry, in radians clockwise from twelve. */
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
