/**
 * Canonical guards for the browser-view layer (8 isRecord and 3 clamp copies
 * consolidated). isRecord excludes arrays: all call sites narrow to keyed
 * property reads.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
