import type {
  PerfFieldValue,
  PerfTelemetryEvent,
} from "./perf-telemetry-writer";

/**
 * Parser for renderer perf-telemetry console lines. Kept electron-free so the
 * routing branch can be unit-tested in isolation; the window factory feeds the
 * result to `appendPerfEvent`.
 *
 * A perf line looks like: `[traycer-perf] {"name":"...","tsMs":123,"fields":{}}`
 * emitted by `gui-app/src/lib/perf/perf-telemetry.ts`.
 */

export const PERF_RENDERER_LOG_PREFIX = "[traycer-perf]";

/**
 * Returns a validated event, or `null` when the line is not a perf line or is
 * malformed. Fields are narrowed to scalar values (number/string/boolean/null);
 * any non-scalar field is dropped rather than trusted.
 */
export function parsePerfRendererLog(
  message: string,
): PerfTelemetryEvent | null {
  if (!message.startsWith(PERF_RENDERER_LOG_PREFIX)) return null;
  const rawJson = message.slice(PERF_RENDERER_LOG_PREFIX.length).trim();
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!isRecord(parsed)) return null;
    const { name, tsMs, fields } = parsed;
    if (typeof name !== "string") return null;
    if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) return null;
    return {
      name,
      tsMs,
      fields: isRecord(fields) ? toScalarFields(fields) : {},
    };
  } catch {
    // Not valid JSON after the prefix - ignore the line.
    return null;
  }
}

function isScalarField(value: unknown): value is PerfFieldValue {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  );
}

function toScalarFields(
  fields: Record<string, unknown>,
): Record<string, PerfFieldValue> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, PerfFieldValue] =>
      isScalarField(entry[1]),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
