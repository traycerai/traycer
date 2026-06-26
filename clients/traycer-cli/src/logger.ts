import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Environment } from "./runner/environment";
import { CliError } from "./runner/errors";
import { cliLogPath } from "./store/paths";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue =
  | string
  | number
  | boolean
  | null
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

export type LogFields = { readonly [key: string]: LogValue };

export interface ILogger {
  debug(message: string, fields: LogFields): void;
  info(message: string, fields: LogFields): void;
  warn(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields, error: Error | null): void;
}

const MAX_LOG_STRING_LENGTH = 1_000;
const MAX_LOG_DEPTH = 4;
const SENSITIVE_FIELD_PATTERN =
  /token|secret|password|authorization|bearer|credential|refresh|cookie|verifier|api[_-]?key/i;
const SENSITIVE_TEXT_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "Bearer [redacted]",
  },
  {
    pattern:
      /((?:access[_-]?token|accessToken|refresh[_-]?token|refreshToken|token|authorization|password|secret|cookie|code[_-]?verifier|codeVerifier|api[_-]?key|apiKey)\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/gi,
    replacement: "$1[redacted]",
  },
];

export const noopLogger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createCliLogger(environment: Environment): ILogger {
  const path = cliLogPath(environment);
  const write = (
    level: LogLevel,
    message: string,
    fields: LogFields,
    error: Error | null,
  ): void => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(
        path,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: sanitizeText(message),
          fields: sanitizeLogValue(fields, null),
          error: error === null ? null : serializeError(error),
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(path, 0o600);
    } catch {
      // Logging must never change CLI behavior.
    }
  };

  return {
    debug: (message, fields) => write("debug", message, fields, null),
    info: (message, fields) => write("info", message, fields, null),
    warn: (message, fields) => write("warn", message, fields, null),
    error: (message, fields, error) => write("error", message, fields, error),
  };
}

export function errorFromUnknown(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

function serializeError(error: Error): {
  readonly name: string;
  readonly code: string | null;
  readonly hasMessage: boolean;
  readonly hasStack: boolean;
} {
  return {
    name: error.name,
    code: error instanceof CliError ? error.code : null,
    hasMessage: error.message.length > 0,
    hasStack: typeof error.stack === "string" && error.stack.length > 0,
  };
}

function sanitizeLogValue(value: LogValue, key: string | null): LogValue {
  return sanitizeLogValueInner(value, key, 0, new WeakSet<object>());
}

function sanitizeLogValueInner(
  value: LogValue,
  key: string | null,
  depth: number,
  seen: WeakSet<object>,
): LogValue {
  if (
    key !== null &&
    SENSITIVE_FIELD_PATTERN.test(key) &&
    (typeof value === "string" ||
      Array.isArray(value) ||
      typeof value === "object")
  ) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (depth >= MAX_LOG_DEPTH) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeLogValueInner(entry, null, depth + 1, seen),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeLogValueInner(entryValue, entryKey, depth + 1, seen),
    ]),
  );
}

function truncateString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}...<truncated>`;
}

function sanitizeText(value: string): string {
  return truncateString(
    SENSITIVE_TEXT_PATTERNS.reduce(
      (current, entry) => current.replace(entry.pattern, entry.replacement),
      value,
    ),
  );
}
