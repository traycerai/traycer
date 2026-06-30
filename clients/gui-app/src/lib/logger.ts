import {
  DEFAULT_LOG_LEVEL,
  logLevelAllows,
  type LogLevel,
} from "@traycer/protocol/config/log-level";

export type AppLogLevel = "debug" | "info" | "warn" | "error";

export type AppLogValue =
  | string
  | number
  | boolean
  | null
  | readonly AppLogValue[]
  | { readonly [key: string]: AppLogValue };

export type AppLogFields = Readonly<Record<string, AppLogValue>>;

const STRUCTURED_LOG_PREFIX = "[traycer-gui]";
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
const NOT_SCALAR_LOG_VALUE = Symbol("not-scalar-log-value");

// The renderer's threshold, hydrated from the desktop log level over IPC (see
// LogLevelBridge). Defaults to debug in dev for DX, info otherwise; in the
// desktop shell the configured `desktopLogLevel` takes over once it loads.
let appLogLevel: LogLevel = import.meta.env.DEV ? "debug" : DEFAULT_LOG_LEVEL;

export function setAppLogLevel(level: LogLevel): void {
  appLogLevel = level;
}

export const appLogger = {
  debug(message: string, fields: AppLogFields): void {
    emitLog("debug", message, fields);
  },
  info(message: string, fields: AppLogFields): void {
    emitLog("info", message, fields);
  },
  warn(message: string, fields: AppLogFields): void {
    emitLog("warn", message, fields);
  },
  error(message: string, fields: AppLogFields, error: unknown): void {
    emitLog("error", message, {
      ...fields,
      error: describeLogError(error),
    });
  },
  errorSummary(message: string, fields: AppLogFields, error: unknown): void {
    emitLog("error", message, {
      ...fields,
      error: describeLogErrorSummary(error),
    });
  },
};

export function redactLogText(value: string): string {
  const redacted = value
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1<redacted>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SENSITIVE_INLINE_VALUE_PATTERN, "$1<redacted>");
  return redacted.length > MAX_LOG_STRING_LENGTH
    ? `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}...<truncated>`
    : redacted;
}

export function sanitizeLogValue(value: unknown, depth: number): AppLogValue {
  const scalar = sanitizeScalarLogValue(value);
  if (scalar !== NOT_SCALAR_LOG_VALUE) return scalar;
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
    const sanitized: Record<string, AppLogValue> = {};
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
  return safeLogTextFromUnknown(value);
}

export function describeLogError(error: unknown): AppLogFields {
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
    message: safeLogTextFromUnknown(error),
    stack: null,
  };
}

export function describeLogErrorSummary(error: unknown): AppLogFields {
  if (error instanceof Error) {
    return {
      name: error.name,
      messageLength: error.message.length,
      stack: null,
    };
  }
  return {
    name: typeof error,
    messageLength: String(error).length,
    stack: null,
  };
}

function emitLog(
  level: AppLogLevel,
  message: string,
  fields: AppLogFields,
): void {
  if (!logLevelAllows(appLogLevel, level)) return;
  const payload = {
    source: "gui-app",
    level,
    message: redactLogText(message),
    fields: sanitizeLogValue(fields, 0),
  };
  const line = `${STRUCTURED_LOG_PREFIX} ${JSON.stringify(payload)}`;
  if (level === "error") {
    console.error(line);
    return;
  }
  // Desktop production forwards renderer warning/error console messages only.
  // The structured payload preserves the logical level; desktop remaps it back
  // to info/warn/error when writing traycer-desktop.log.
  console.warn(line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeScalarLogValue(
  value: unknown,
): AppLogValue | typeof NOT_SCALAR_LOG_VALUE {
  if (value === null) return null;
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "<undefined>";
  if (typeof value === "function") return "<function>";
  if (typeof value === "symbol") return value.description ?? "<symbol>";
  return NOT_SCALAR_LOG_VALUE;
}

function safeLogTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "symbol") {
    return redactLogText(value.description ?? "<symbol>");
  }
  if (typeof value === "function") return "<function>";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "<undefined>";
  if (typeof value === "object") return Object.prototype.toString.call(value);
  return "<unknown>";
}
