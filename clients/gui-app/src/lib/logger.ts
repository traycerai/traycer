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

export const appLogger = {
  debug(message: string, fields: AppLogFields): void {
    if (!import.meta.env.DEV) return;
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
    .replace(BEARER_PATTERN, "Bearer <redacted>");
  return redacted.length > MAX_LOG_STRING_LENGTH
    ? `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}...<truncated>`
    : redacted;
}

export function sanitizeLogValue(value: unknown, depth: number): AppLogValue {
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
  if (typeof value === "undefined") return "<undefined>";
  return redactLogText(String(value));
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
    message: redactLogText(String(error)),
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
