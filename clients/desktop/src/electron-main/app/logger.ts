import log from "electron-log";
import { app } from "electron";
import { join } from "node:path";
import {
  loadEffectiveDiagnosticsConfigSync,
  redactDiagnosticsText,
  type DiagnosticLogLevel,
} from "@traycer/protocol/config";

export type SafeLogValue =
  | string
  | number
  | boolean
  | null
  | readonly SafeLogValue[]
  | { readonly [key: string]: SafeLogValue };

export type SafeLogFields = Readonly<Record<string, SafeLogValue>>;

const MAX_LOG_STRING_LENGTH = 1_000;
const MAX_LOG_DEPTH = 4;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_OBJECT_KEYS = 40;
const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|authorization|cookie|credential|verifier|refresh|bearer|api[_-]?key|client[_-]?secret)/i;
const EXPIRY_REFRESH_SLOP_MS = 250;

let diagnosticsExpiryTimer: NodeJS.Timeout | null = null;

/**
 * Configures `electron-log` so the desktop shell, the renderer, and any
 * spawned host-lifecycle diagnostics flow through a single sink.
 *
 * The host itself writes to `~/.traycer/host/host.log` in production and
 * `~/.traycer/host/dev/host.log` in dev - see `host-paths.ts`. Our own
 * main-process log is kept separate at
 * `userData/traycer-desktop.log` so the two are easy to differentiate in
 * support bundles.
 */
export function initLogger(): void {
  const logPath = resolveDesktopLogPath();
  log.transports.file.resolvePathFn = () => logPath;
  const diagnosticsLevel = refreshDesktopDiagnosticsLogLevel();
  log.info("[desktop] logger initialised", { logPath, diagnosticsLevel });
}

export function refreshDesktopDiagnosticsLogLevel(): DiagnosticLogLevel {
  const effective = loadEffectiveDiagnosticsConfigSync(new Date());
  applyDesktopDiagnosticsLogLevel(effective.general.level);
  scheduleDiagnosticsExpiryRefresh(effective.general.expiresAt);
  return effective.general.level;
}

export function applyDesktopDiagnosticsLogLevel(
  level: DiagnosticLogLevel,
): void {
  const electronLogLevel = electronLogLevelFor(level);
  log.transports.file.level = electronLogLevel;
  log.transports.console.level = electronLogLevel;
}

function scheduleDiagnosticsExpiryRefresh(expiresAt: string | null): void {
  if (diagnosticsExpiryTimer !== null) {
    clearTimeout(diagnosticsExpiryTimer);
    diagnosticsExpiryTimer = null;
  }
  if (expiresAt === null) {
    return;
  }
  const delayMs = Date.parse(expiresAt) - Date.now() + EXPIRY_REFRESH_SLOP_MS;
  diagnosticsExpiryTimer = setTimeout(
    () => {
      diagnosticsExpiryTimer = null;
      refreshDesktopDiagnosticsLogLevel();
    },
    Math.max(delayMs, 0),
  );
  diagnosticsExpiryTimer.unref();
}

export function resolveDesktopLogPath(): string {
  return join(app.getPath("userData"), "traycer-desktop.log");
}

export function redactLogText(value: string): string {
  const redacted = redactDiagnosticsText(value);
  return redacted.length > MAX_LOG_STRING_LENGTH
    ? `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}...<truncated>`
    : redacted;
}

export function sanitizeLogFields(
  fields: Record<string, unknown>,
): SafeLogFields {
  return sanitizeLogRecord(fields, 0);
}

export function sanitizeLogValue(value: unknown, depth: number): SafeLogValue {
  if (value === null) return null;
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= MAX_LOG_DEPTH) return "<max-depth>";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((entry) => sanitizeLogValue(entry, depth + 1));
  }
  if (value instanceof Error) {
    return describeLogError(value);
  }
  if (isRecord(value)) {
    return sanitizeLogRecord(value, depth);
  }
  if (typeof value === "undefined") return "<undefined>";
  return redactLogText(String(value));
}

export function describeLogError(error: unknown): SafeLogFields {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactLogText(error.message),
      stack:
        typeof error.stack === "string" ? redactLogText(error.stack) : null,
    };
  }
  return {
    name: typeof error,
    message: redactLogText(String(error)),
    stack: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function electronLogLevelFor(
  level: DiagnosticLogLevel,
): "debug" | "info" | "warn" | "error" | false {
  switch (level) {
    case "trace":
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "off":
      return false;
  }
}

function sanitizeLogRecord(
  value: Record<string, unknown>,
  depth: number,
): Record<string, SafeLogValue> {
  const sanitized: Record<string, SafeLogValue> = {};
  for (const [key, entry] of Object.entries(value).slice(
    0,
    MAX_LOG_OBJECT_KEYS,
  )) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "<redacted>"
      : sanitizeLogValue(entry, depth + 1);
  }
  return sanitized;
}

export { log };
