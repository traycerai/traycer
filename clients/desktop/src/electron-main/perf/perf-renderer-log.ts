import type {
  PerfFieldValue,
  PerfTelemetryEvent,
} from "./perf-telemetry-writer";


export const PERF_RENDERER_LOG_PREFIX = "[traycer-perf]";

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
