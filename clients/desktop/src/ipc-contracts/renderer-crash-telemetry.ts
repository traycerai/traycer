import type { RendererCrashTelemetryInput } from "@traycer-clients/shared/platform/runner-host";

const RENDERER_CRASH_TELEMETRY_KEYS = new Set([
  "appVersion",
  "buildRevision",
  "componentStack",
  "correlationId",
  "fingerprint",
  "timestamp",
]);

export function parseRendererCrashTelemetryInput(
  input: unknown,
): RendererCrashTelemetryInput {
  if (!isRecord(input)) {
    throw new TypeError("renderer crash telemetry must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!RENDERER_CRASH_TELEMETRY_KEYS.has(key)) {
      throw new TypeError(`renderer crash telemetry has unknown key: ${key}`);
    }
  }
  return {
    appVersion: parseNullableBoundedString(input.appVersion, "appVersion", 128),
    buildRevision: parseNullableBoundedString(
      input.buildRevision,
      "buildRevision",
      128,
    ),
    componentStack: parseNullableBoundedString(
      input.componentStack,
      "componentStack",
      64_000,
    ),
    correlationId: parseBoundedString(
      input.correlationId,
      "correlationId",
      128,
    ),
    fingerprint: parseBoundedString(input.fingerprint, "fingerprint", 512),
    timestamp: parseFiniteNumber(input.timestamp, "timestamp"),
  };
}

function parseNullableBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return parseBoundedString(value, field, maxLength);
}

function parseBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(
      `${field} must be a string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function parseFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
