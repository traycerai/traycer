import log from "electron-log";
import { app } from "electron";
import { join } from "node:path";
import { isDevBuild } from "../../config";
import {
  applyDesktopLogLevel,
  readDesktopLogLevelSync,
} from "./desktop-log-level";
import {
  redactSensitiveText,
  SENSITIVE_KEY_PATTERN,
} from "@traycer/protocol/utils/text/redaction";

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

export function initLogger(): void {
  const logPath = resolveDesktopLogPath();
  log.transports.file.resolvePathFn = () => logPath;
  // The file transport  -  which persists both our own logs and the renderer's
  // forwarded console logs  -  follows the configured desktop level (default
  // info), so Settings → log level controls what lands in traycer-desktop.log.
  applyDesktopLogLevel(readDesktopLogLevelSync());
  log.transports.console.level = isDevBuild ? "debug" : "info";
  installSanitizingHook();
  log.info("[desktop] logger initialised", { logPath });
}

function installSanitizingHook(): void {
  log.hooks.push((message) => {
    message.data = message.data.map(sanitizeLogArgument);
    return message;
  });
}

function sanitizeLogArgument(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  return sanitizeLogValue(value, 0);
}

export function resolveDesktopLogPath(): string {
  return join(app.getPath("userData"), "traycer-desktop.log");
}

export function redactLogText(value: string): string {
  const redacted = redactSensitiveText(value);
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
