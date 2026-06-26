import log from "electron-log";
import { app } from "electron";
import { join } from "node:path";
import { isDevBuild } from "../../config";

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
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:access_token|refresh_token|id_token|token|code|code_verifier|password|secret|client_secret|api_key|authorization)=)([^&#\s]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_INLINE_VALUE_PATTERN =
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code[_-]?verifier|password|secret|client[_-]?secret|api[_-]?key|authorization|cookie|credential)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

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
  log.transports.file.level = "info";
  // Console transport is noisy by design (every IPC + lifecycle log).
  // Shipped builds get the same `info` level the file transport does so
  // electron-log's stdout/stderr capture doesn't leak debug payloads to a
  // user's system console; the dev slot keeps `debug`.
  log.transports.console.level = isDevBuild ? "debug" : "info";
  log.info("[desktop] logger initialised", { logPath });
}

export function resolveDesktopLogPath(): string {
  return join(app.getPath("userData"), "traycer-desktop.log");
}

export function redactLogText(value: string): string {
  const redacted = value
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1<redacted>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SENSITIVE_INLINE_VALUE_PATTERN, "$1<redacted>");
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
